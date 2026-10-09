#!/usr/bin/env node
/**
 * Live admission capture: an ACP client drives pi-acp -> pi (+/- this extension) against a
 * scripted local model, records every frame in both directions, and answers each
 * `session/request_permission` with the policy given on the command line.
 *
 * Offline and account-free: pi's agent dir and HOME are fresh temp dirs, the model is
 * `mock-openai.mjs` on 127.0.0.1, and PI_OFFLINE=1 stops pi's startup network calls.
 *
 *   node test/live/capture.mjs --pi-acp <path to pi-acp dist/index.js> \
 *     --scenario write|four --answer allow|deny --gate on|off --out <dir>
 *
 * Writes <out>/<label>/frames.jsonl, model.jsonl and summary.json, and exits 0 when the
 * summary's `verdict` holds for the scenario.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-openai.mjs';
import { ENVELOPE_KEY } from '../../extensions/pi-governance.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const piAcp = resolve(arg('pi-acp', ''));
const scenario = arg('scenario', 'write');
const answer = arg('answer', 'deny');
const gate = arg('gate', 'on') === 'on';
const outRoot = resolve(arg('out', 'evidence/capture'));
const label = `${scenario}-${gate ? 'gate' : 'nogate'}-${answer}`;
const out = join(outRoot, label);
mkdirSync(out, { recursive: true });

const base = mkdtempSync(join(tmpdir(), 'pi-gov-'));
const work = join(base, 'work');
const agentDir = join(base, 'agent');
const home = join(base, 'home');
for (const d of [work, agentDir, home]) mkdirSync(d, { recursive: true });
writeFileSync(join(work, 'seed.txt'), 'alpha\n');

const target = (f) => join(work, f);
const SCENARIOS = {
  write: [{ tool: 'write', args: { path: target('governed-write.txt'), content: 'written\n' } }, { text: 'done' }],
  four: [
    { tool: 'read', args: { path: target('seed.txt') } },
    { tool: 'bash', args: { command: `echo hi > ${target('bash-out.txt')}` } },
    { tool: 'edit', args: { path: target('seed.txt'), edits: [{ oldText: 'alpha', newText: 'beta' }] } },
    { tool: 'write', args: { path: target('governed-write.txt'), content: 'written\n' } },
    { text: 'done' },
  ],
};
const steps = SCENARIOS[scenario];
if (!steps || !['allow', 'deny'].includes(answer)) {
  console.error(`usage: --scenario ${Object.keys(SCENARIOS).join('|')} --answer allow|deny --gate on|off`);
  process.exit(64);
}
const mock = await startMock({ steps, log: join(out, 'model.jsonl') });

writeFileSync(
  join(agentDir, 'models.json'),
  JSON.stringify({
    providers: {
      mock: {
        baseUrl: mock.url,
        api: 'openai-completions',
        apiKey: 'mock-key-not-a-secret',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'mock-1' }],
      },
    },
  }),
);
writeFileSync(
  join(agentDir, 'settings.json'),
  JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultProjectTrust: 'never' }),
);

const launcherScript = fileURLToPath(new URL('./pi-launch.mjs', import.meta.url));
// pi-acp spawns PI_ACP_PI_COMMAND as a command. POSIX runs the script by its shebang; Windows
// cannot run a .mjs directly, so it gets a .cmd shim (pi-acp starts .cmd files through a shell).
let launcher = launcherScript;
if (process.platform === 'win32') {
  launcher = join(base, 'pi-launch.cmd');
  writeFileSync(launcher, `@"${process.execPath}" "${launcherScript}" %*\r\n`);
} else {
  chmodSync(launcherScript, 0o755);
}
const versions = {
  pi: execFileSync(process.env.PI_GOV_PI_BINARY || 'pi', ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' } }).trim(),
  piAcp: JSON.parse(readFileSync(resolve(piAcp, '..', '..', 'package.json'), 'utf8')).version,
  piGovernance: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version,
  node: process.version,
};

const t0 = Date.now();
let seq = 0;
const frames = join(out, 'frames.jsonl');
writeFileSync(frames, '');
const record = (dir, msg) => {
  seq += 1;
  appendFileSync(frames, JSON.stringify({ seq, ms: Date.now() - t0, dir, msg }) + '\n');
  return seq;
};

const child = spawn(process.execPath, [piAcp], {
  cwd: work,
  env: {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_ACP_PI_COMMAND: launcher,
    PI_GOV_GATE: gate ? '1' : '0',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));

let nextId = 1;
const pending = new Map();
const send = (msg) => {
  record('client->agent', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
};
const request = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    send({ jsonrpc: '2.0', id, method, params });
  });

const permissions = [];
const toolUpdates = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      record('agent->client(unparsed)', line);
      continue;
    }
    const s = record('agent->client', msg);
    if (msg.id !== undefined && !msg.method) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.rej(msg.error) : p.res(msg.result);
      }
      continue;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        toolUpdates.push({ seq: s, toolCallId: u.toolCallId, status: u.status ?? null, kind: u.kind ?? null, title: u.title ?? null });
      }
      continue;
    }
    if (msg.method === 'session/request_permission') {
      const params = msg.params ?? {};
      let env = null;
      try {
        const parsed = JSON.parse(params.toolCall?.rawInput?.message ?? 'null');
        if (parsed && typeof parsed === 'object' && parsed[ENVELOPE_KEY]) env = parsed;
      } catch {
        /* not ours */
      }
      const want = env ? answer === 'allow' : true; // non-gate dialogs (none expected) are allowed and recorded
      const kinds = want ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
      const opt = (params.options ?? []).find((o) => kinds.includes(o.kind));
      const result = opt
        ? { outcome: { outcome: 'selected', optionId: opt.optionId } }
        : { outcome: { outcome: 'cancelled' } };
      const rs = record('client->agent', { jsonrpc: '2.0', id: msg.id, result });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      permissions.push({
        requestSeq: s,
        answerSeq: rs,
        envelope: env,
        title: params.toolCall?.title ?? null,
        rawTitle: params.toolCall?.rawInput?.title ?? null,
        method: params.toolCall?.rawInput?.method ?? null,
        answered: want ? 'allow' : 'reject',
      });
      continue;
    }
    if (msg.id !== undefined && msg.method) {
      // Any other agent->client request: we advertised no fs/terminal capability.
      const reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `not supported: ${msg.method}` } };
      record('client->agent', reply);
      child.stdin.write(JSON.stringify(reply) + '\n');
    }
  }
});

const timeout = setTimeout(() => {
  console.error('capture timed out');
  child.kill('SIGKILL');
  process.exit(2);
}, 120_000);

let stopReason = null;
let error = null;
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const s = await request('session/new', { cwd: work, mcpServers: [] });
  const r = await request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Run the scripted steps.' }] });
  stopReason = r?.stopReason ?? null;
} catch (e) {
  error = e;
}
clearTimeout(timeout);
child.kill('SIGTERM');
await mock.close();

const files = {
  'governed-write.txt': existsSync(target('governed-write.txt')),
  'bash-out.txt': existsSync(target('bash-out.txt')),
  'seed.txt': readFileSync(target('seed.txt'), 'utf8'),
};

// Per tool call (pi's own toolCallId): the first `in_progress`/`completed`, and the permission
// answer that names that id in its envelope.
const perCall = {};
for (const u of toolUpdates) {
  const c = (perCall[u.toolCallId] ??= { toolCallId: u.toolCallId, statuses: [] });
  c.statuses.push({ seq: u.seq, status: u.status });
}
for (const p of permissions) {
  const id = p.envelope?.toolCallId;
  if (!id) continue;
  const c = (perCall[id] ??= { toolCallId: id, statuses: [] });
  c.permission = { requestSeq: p.requestSeq, answerSeq: p.answerSeq, tool: p.envelope.toolName, answered: p.answered };
}

const expectedTools = steps.filter((x) => x.tool).map((x) => x.tool);
const askedTools = permissions.filter((p) => p.envelope).map((p) => p.envelope.toolName);
const calls = Object.values(perCall);
const ranBeforeAnswer = calls.filter((c) => {
  const firstCompleted = c.statuses.find((x) => x.status === 'completed');
  return firstCompleted && (!c.permission || firstCompleted.seq < c.permission.answerSeq);
});
let verdict;
if (gate) {
  const allAsked = JSON.stringify(askedTools) === JSON.stringify(expectedTools);
  // The request a title-only host would see must name the tool too.
  const requestsNameTheTool = permissions
    .filter((p) => p.envelope)
    .every((p) => p.title === p.envelope.toolName && p.rawTitle === p.envelope.toolName && p.method === 'confirm');
  // Deny: every governed call ends `failed` and never reports `completed` (a denied `read` that
  // still ran would show up here even though it leaves no file behind). Allow: every governed
  // call completes, and only after its answer.
  const governed = calls.filter((c) => c.permission);
  const statusesMatchAnswer =
    governed.length === expectedTools.length &&
    governed.every((c) =>
      answer === 'deny'
        ? !c.statuses.some((x) => x.status === 'completed') && c.statuses.at(-1)?.status === 'failed'
        : c.statuses.some((x) => x.status === 'completed' && x.seq > c.permission.answerSeq),
    );
  const sideEffects = answer === 'deny'
    ? !files['governed-write.txt'] && !files['bash-out.txt'] && files['seed.txt'] === 'alpha\n'
    : files['governed-write.txt'] && (scenario === 'write' || (files['bash-out.txt'] && files['seed.txt'] === 'beta\n'));
  verdict = {
    allAsked,
    requestsNameTheTool,
    noCompletionBeforeAnswer: ranBeforeAnswer.length === 0,
    statusesMatchAnswer,
    sideEffectsMatchAnswer: Boolean(sideEffects),
  };
} else {
  verdict = { baselineNoPermissionRequests: permissions.length === 0, baselineWriteHappened: files['governed-write.txt'] };
}
const ok = Object.values(verdict).every(Boolean);
const summary = {
  label,
  takenAt: new Date().toISOString(),
  versions,
  scenario,
  gate,
  answer,
  stopReason,
  error: error ? String(error?.message ?? JSON.stringify(error)) : null,
  expectedTools,
  askedTools,
  permissions,
  perCall: calls,
  files,
  verdict,
  ok,
  stderrTail: stderr.slice(-2000),
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ label, ok, verdict, askedTools, files, stopReason, error: summary.error }));
process.exit(ok ? 0 : 1);
