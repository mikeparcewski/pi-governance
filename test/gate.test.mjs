import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piGovernance, {
  decide, envelope, reduce, fits, displayWidth, notify, REASONS, VERSION, STRING_LIMIT,
} from '../extensions/pi-governance.js';

const TOOLS = ['read', 'bash', 'write', 'edit', 'grep', 'find', 'ls', 'some_extension_tool'];

/** A fake ctx.ui. `confirmAnswer` / `inputAnswer` may be a value, an Error (throws) or a function. */
const fakeCtx = ({ confirmAnswer, inputAnswer, hasUI = true } = {}) => {
  const calls = { confirm: [], input: [] };
  const run = (a, ...args) => (typeof a === 'function' ? a(...args) : a instanceof Error ? Promise.reject(a) : a);
  return {
    calls,
    ctx: {
      hasUI,
      ui: {
        confirm: async (title, message, opts) => { calls.confirm.push({ title, message, opts }); return run(confirmAnswer, opts); },
        input: async (title, ph, opts) => { calls.input.push({ title, opts }); return run(inputAnswer, opts); },
      },
    },
  };
};
const ev = (toolName, input = { path: '/w/a.txt' }) => ({ toolName, toolCallId: 'c1', input });
const never = (opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));

test('every tool, read included, reaches confirm once with its canonical name', async () => {
  for (const tool of TOOLS) {
    const { ctx, calls } = fakeCtx({ confirmAnswer: true });
    assert.equal(await decide(ev(tool), ctx), undefined, tool);
    assert.equal(calls.confirm.length, 1, tool);
    assert.equal(calls.confirm[0].title, tool);
  }
});

test('only a literal true runs the call', async () => {
  for (const answer of [false, undefined, null, 'yes', 1, {}]) {
    const { ctx } = fakeCtx({ confirmAnswer: answer, inputAnswer: 'because' });
    const r = await decide(ev('write'), ctx);
    assert.equal(r?.block, true, String(answer));
  }
});

test('no opens the reason input and returns the typed text unchanged', async () => {
  for (const reason of ['  nope, "quoted" \\ back — ünï 日本語 🙂  ', 'a\tb']) {
    const { ctx, calls } = fakeCtx({ confirmAnswer: false, inputAnswer: reason });
    assert.deepEqual(await decide(ev('bash'), ctx), { block: true, reason });
    assert.equal(calls.input.length, 1);
  }
});

test('an empty or whitespace reason falls back to the fixed denial', async () => {
  for (const reason of ['', '   ', '\n\t']) {
    const { ctx } = fakeCtx({ confirmAnswer: false, inputAnswer: reason });
    assert.deepEqual(await decide(ev('bash'), ctx), { block: true, reason: REASONS.denied });
  }
});

test('escape at the confirm blocks at once and never opens the reason input', async () => {
  const { ctx, calls } = fakeCtx({ confirmAnswer: undefined, inputAnswer: 'x' });
  assert.deepEqual(await decide(ev('bash'), ctx), { block: true, reason: REASONS.cancelled });
  assert.equal(calls.input.length, 0);
});

test('escape at the reason input blocks', async () => {
  const { ctx } = fakeCtx({ confirmAnswer: false, inputAnswer: undefined });
  assert.deepEqual(await decide(ev('bash'), ctx), { block: true, reason: REASONS.cancelled });
});

test('a thrown confirm or input blocks with the error reason', async () => {
  let { ctx } = fakeCtx({ confirmAnswer: new Error('pipe closed') });
  assert.deepEqual(await decide(ev('bash'), ctx), { block: true, reason: REASONS.error });
  ({ ctx } = fakeCtx({ confirmAnswer: false, inputAnswer: new Error('boom') }));
  assert.deepEqual(await decide(ev('bash'), ctx), { block: true, reason: REASONS.error });
});

test('a confirm timeout blocks, aborts the dialog, and a late yes cannot authorize', async () => {
  let late;
  const { ctx, calls } = fakeCtx({
    confirmAnswer: (opts) => new Promise((resolve) => { late = resolve; opts.signal.addEventListener('abort', () => {}); }),
  });
  const r = await decide(ev('bash'), ctx, { timeoutMs: 20 });
  assert.deepEqual(r, { block: true, reason: REASONS.timeout });
  assert.equal(calls.confirm[0].opts.signal.aborted, true);
  late(true); // too late: the decision was already returned
  assert.equal(r.block, true);
});

test('a reason-input timeout blocks', async () => {
  const { ctx } = fakeCtx({ confirmAnswer: false, inputAnswer: never });
  assert.deepEqual(await decide(ev('bash'), ctx, { timeoutMs: 20 }), { block: true, reason: REASONS.timeout });
});

test('the production timeout is 600 s and nothing in the environment changes it', async () => {
  process.env.WICKED_SEAT_ASK_TIMEOUT_MS = '1';
  try {
    const { ctx, calls } = fakeCtx({ confirmAnswer: true });
    await decide(ev('read'), ctx);
    assert.equal(calls.confirm[0].opts.timeout, 600_000);
  } finally {
    delete process.env.WICKED_SEAT_ASK_TIMEOUT_MS;
  }
});

test('no UI blocks every tool with the headless reason and never touches ui', async () => {
  for (const tool of TOOLS) {
    for (const ctx of [fakeCtx({ hasUI: false }).ctx, {}, undefined]) {
      assert.deepEqual(await decide(ev(tool), ctx), { block: true, reason: 'tools are off in headless mode' }, tool);
    }
  }
  const { ctx, calls } = fakeCtx({ hasUI: false });
  await decide(ev('read'), ctx);
  assert.equal(calls.confirm.length + calls.input.length, 0);
});

test('the envelope is one compact JSON line {v:2, tool, input}', () => {
  const input = { command: 'echo "a"\nls', n: 3, nested: [1, { k: null }] };
  const { title, line } = envelope(ev('bash', input));
  assert.equal(title, 'bash');
  assert.ok(!line.includes('\n'));
  assert.deepEqual(JSON.parse(line), { v: 2, tool: 'bash', input });
  assert.deepEqual(Object.keys(JSON.parse(line)), ['v', 'tool', 'input']);
});

test('reduce replaces strings over the byte limit with their size and sha256', () => {
  const at = 'a'.repeat(STRING_LIMIT);
  const over = 'a'.repeat(STRING_LIMIT + 1);
  const multi = '日'.repeat(86); // 258 bytes, 86 characters
  const input = { at, over, deep: [{ multi }], keep: 7 };
  const snapshot = structuredClone(input);
  const out = reduce(input);
  assert.deepEqual(input, snapshot, 'input is not mutated');
  assert.equal(out.at, at);
  assert.deepEqual(out.over, { bytes: 257, sha256: createHash('sha256').update(over).digest('hex') });
  assert.deepEqual(out.deep[0].multi, { bytes: 258, sha256: createHash('sha256').update(multi).digest('hex') });
  assert.equal(out.keep, 7);
});

test('a big file body is reviewable by hash, not blocked', async () => {
  const { ctx } = fakeCtx({ confirmAnswer: true });
  assert.equal(await decide(ev('write', { path: '/w/a', content: 'x'.repeat(1e6) }), ctx), undefined);
});

test('an envelope too big for the pane blocks before the dialog', async () => {
  const manyShort = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${i}`, 'v'.repeat(100)]));
  // 200 strings of 85 CJK characters: 255 bytes each, so reduction leaves them, yet 34000 cells wrap past the pane.
  const wide = { w: Array.from({ length: 200 }, () => '日'.repeat(85)) };
  for (const input of [manyShort, wide]) {
    const { ctx, calls } = fakeCtx({ confirmAnswer: true });
    assert.deepEqual(await decide(ev('write', input), ctx), { block: true, reason: 'action too large to review' });
    assert.equal(calls.confirm.length, 0);
  }
});

test('250 strings of 50 rockets (U+1F680) block before confirm', async () => {
  const input = { r: Array.from({ length: 250 }, () => '\u{1F680}'.repeat(50)) };
  const { ctx, calls } = fakeCtx({ confirmAnswer: true });
  assert.deepEqual(await decide(ev('write', input), ctx), { block: true, reason: 'action too large to review' });
  assert.equal(calls.confirm.length, 0);
  assert.equal(displayWidth('\u{1F680}'), 2);
  assert.equal(displayWidth('e\u0301'), 1);
});

test('a confirm that rejects when aborted still yields the timeout reason', async () => {
  const { ctx } = fakeCtx({ confirmAnswer: never });
  assert.deepEqual(await decide(ev('bash'), ctx, { timeoutMs: 20 }), { block: true, reason: REASONS.timeout });
  const second = fakeCtx({ confirmAnswer: false, inputAnswer: never });
  assert.deepEqual(await decide(ev('bash'), second.ctx, { timeoutMs: 20 }), { block: true, reason: REASONS.timeout });
});

test('headless wins over a guard failure', async () => {
  process.env.WICKED_SEAT_SHELL = '/nonexistent/guard';
  try {
    const handlers = {};
    await piGovernance({ on: (n, f) => (handlers[n] = f), registerTool() {} });
    for (const ctx of [{ hasUI: false }, {}, undefined]) {
      assert.deepEqual(await handlers.tool_call(ev('bash'), ctx), { block: true, reason: 'tools are off in headless mode' });
    }
  } finally {
    delete process.env.WICKED_SEAT_SHELL;
  }
});

test('display width counts cells: wide characters are 2, combining marks 0', () => {
  assert.equal(displayWidth('日'.repeat(250)), 500);
  assert.equal(fits('日'.repeat(250 * 45)), false);
  assert.equal(fits('a'.repeat(250 * 45)), true); // 11250 cells wrap to ~47 rows; the same count of CJK is 94
  assert.equal(displayWidth('é'), 1);
  assert.equal(displayWidth('a'), 1);
  assert.equal(fits('a'.repeat(100)), true);
});

test('fits uses width, not character count', () => {
  const usable = 250 - 8;
  const rows = 80 - 14;
  const edge = (rows - 1) * usable;
  assert.equal(fits('a'.repeat(edge)), true);
  assert.equal(fits('a'.repeat(edge + usable)), false);
  assert.equal(fits('日'.repeat(edge / 2 + usable)), false); // same char count would fit as ASCII
});

/** A unix-socket listener that collects whole lines. */
const listen = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-gov-sock-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\pigov-${process.pid}-${Date.now()}` : join(dir, 'gate.sock');
  const lines = [];
  const server = createServer((c) => {
    let buf = '';
    c.on('data', (d) => (buf += d));
    c.on('end', () => lines.push(...buf.split('\n').filter(Boolean)));
  });
  await new Promise((r) => server.listen(path, r));
  return { path, lines, close: async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); } };
};
const noSock = process.platform === 'win32' ? '\\\\.\\pipe\\no-such-pi-gov' : join(tmpdir(), 'no-such-pi-gov.sock');
const settle = () => new Promise((r) => setTimeout(r, 50));

test('the load record goes once per session and turn-end once per turn', async (t) => {
  const sock = await listen();
  t.after(sock.close);
  const handlers = {};
  await piGovernance({ on: (n, f) => (handlers[n] = f), registerTool() {} }, { socketPath: sock.path });
  assert.deepEqual(Object.keys(handlers).sort(), ['agent_end', 'session_start', 'tool_call']);
  await handlers.session_start({}, {});
  await handlers.agent_end({}, {});
  await handlers.agent_end({}, {});
  await settle();
  assert.deepEqual(sock.lines.map((l) => JSON.parse(l)), [
    { ext: 'pi-governance', version: '0.2.0' },
    { ext: 'pi-governance', event: 'turn-end' },
    { ext: 'pi-governance', event: 'turn-end' },
  ]);
});

test('a missing or refused socket never breaks a hook', async () => {
  assert.equal(await notify({ a: 1 }, undefined), false);
  assert.equal(await notify({ a: 1 }, noSock), false);
  const handlers = {};
  await piGovernance({ on: (n, f) => (handlers[n] = f) }, { socketPath: noSock });
  await handlers.session_start({}, {});
  await handlers.agent_end({}, {});
});

test('without WICKED_SEAT_SHELL the bash tool is left alone', async () => {
  delete process.env.WICKED_SEAT_SHELL;
  const registered = [];
  await piGovernance({ on() {}, registerTool: (t) => registered.push(t) });
  assert.equal(registered.length, 0);
});

test('with WICKED_SEAT_SHELL set and pi unavailable, bash fails closed and others still ask', async () => {
  process.env.WICKED_SEAT_SHELL = '/nonexistent/guard';
  try {
    const handlers = {};
    await piGovernance({ on: (n, f) => (handlers[n] = f), registerTool() {} });
    const { ctx } = fakeCtx({ confirmAnswer: true });
    const r = await handlers.tool_call(ev('bash'), ctx);
    assert.equal(r.block, true);
    assert.ok(r.reason.startsWith(REASONS.guard));
    assert.equal(await handlers.tool_call(ev('read'), ctx), undefined);
  } finally {
    delete process.env.WICKED_SEAT_SHELL;
  }
});

test('the extension version matches the manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
