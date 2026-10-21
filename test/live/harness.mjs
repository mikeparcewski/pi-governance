/**
 * Helpers for driving interactive pi in a tmux pane. Everything scratch lives under os.tmpdir()
 * and is removed by `dispose`; pane captures worth keeping go under the notes root.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-model.mjs';

export const EXTENSION = fileURLToPath(new URL('../../extensions/pi-governance.js', import.meta.url));
export const COLS = 250;
export const ROWS = 80;

const have = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0 || spawnSync(cmd, ['-V'], { stdio: 'ignore' }).status === 0;
export const missing = () => ['pi', 'tmux'].filter((c) => !have(c));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' });

/** Poll until `fn` returns truthy, or fail with `what` and the last pane. */
export async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/**
 * A fresh seat: scratch root, agent dir with a provider pointing at the stub, a tmux session with pi
 * running only this extension. `extraEnv` is added to pi's environment; `settings` extends settings.json.
 */
export async function seat({ steps, extraEnv = {}, settings = {}, notes }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-gov-live-'));
  const work = join(root, 'work');
  const agent = join(root, 'agent');
  const home = join(root, 'home');
  for (const d of [work, agent, home]) mkdirSync(d, { recursive: true });
  const stub = await startStub(steps);
  writeFileSync(join(agent, 'models.json'), JSON.stringify({
    providers: { mock: { baseUrl: stub.url, api: 'openai-completions', apiKey: 'mock-key-not-a-secret',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: 'mock-1' }] } },
  }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultProjectTrust: 'never', ...settings }));
  const session = `pigov-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', ...extraEnv };
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  tmux('new-session', '-d', '-s', session, '-x', String(COLS), '-y', String(ROWS), '-c', work,
    'env', ...envArgs, 'pi', '-ne', '-e', EXTENSION, '--provider', 'mock', '--model', 'mock-1');
  let disposed = false;
  const s = {
    root, work, agent, stub, session,
    pane: () => { try { return tmux('capture-pane', '-p', '-t', session); } catch { return ''; } },
    alive: () => spawnSync('tmux', ['has-session', '-t', session]).status === 0 &&
      tmux('list-panes', '-t', session, '-F', '#{pane_dead}').trim() === '0',
    keys: (...k) => tmux('send-keys', '-t', session, ...k),
    type: (text) => tmux('send-keys', '-t', session, '-l', text),
    /** tmux load-buffer + paste-buffer -p: a bracketed paste of exactly these bytes. */
    paste: (data) => {
      const f = join(root, `paste-${Math.random().toString(36).slice(2)}`);
      writeFileSync(f, data);
      tmux('load-buffer', '-b', 'pigov', f);
      tmux('paste-buffer', '-p', '-d', '-b', 'pigov', '-t', session);
    },
    waitPane: (re, what, ms) => until(() => (re.test(s.pane()) ? s.pane() : false), what ?? String(re), ms),
    /** Wait for the permission dialog for `tool`; the whole envelope's tail must be on screen. */
    waitDialog: (tool) => s.waitPane(new RegExp(`"tool":"${tool}"`), `${tool} dialog`),
    save: (name) => { if (notes) { mkdirSync(notes, { recursive: true }); writeFileSync(join(notes, name), s.pane()); } },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      spawnSync('tmux', ['kill-session', '-t', session]);
      spawnSync('tmux', ['delete-buffer', '-b', 'pigov']);
      await stub.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  try {
    await s.waitPane(/mock-1|›|>/, 'pi to start', 120_000);
  } catch (err) {
    dumpPane(s, err); // the stub's open server would otherwise keep the test process alive forever
    await s.dispose();
    throw err;
  }
  return s;
}

/** Print the visible pane to stderr so a CI tail shows why a wait failed. */
export function dumpPane(s, err) {
  process.stderr.write(`pi-governance live: ${err?.message ?? err}\n--- pane (${COLS}x${ROWS}) ---\n${s.pane()}\n--- end pane ---\n`);
}

/** Tool-result messages the stub has received, as text. */
export const toolResults = (stub) =>
  stub.requests.flatMap((r) => (r.messages ?? []).filter((m) => m.role === 'tool'))
    .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join('') : JSON.stringify(m.content)));

export const exists = existsSync;
