/**
 * pi-governance 0.2: pi has no approval prompt of its own, so this extension gives it one.
 *
 * The seam is pi's `tool_call` hook. pi awaits it before a tool runs, and `{ block: true, reason }`
 * means the tool never runs (a handler that throws also blocks). Every call, `read` included, is
 * put to `ctx.ui.confirm`; the engine's tmux layer answers the dialog through the pane.
 *
 * Rules (each one is a way the defect this replaces could come back):
 * - Every tool asks. No tool is safe by name.
 * - Only an explicit `true` runs the call. A no, a cancel, a timeout, a thrown dialog and a mode
 *   with no UI are all blocks, each with its own fixed or typed reason.
 * - On a no the extension opens a one-line input and returns that text, unchanged, as the block
 *   reason, so the model's next step sees why.
 * - The envelope is one compact JSON line, `{"v":2,"tool":...,"input":...}`, with large strings
 *   replaced by `{bytes, sha256}`. One that would not fit the dialog is blocked unasked, because a
 *   truncated screen is unreadable to the answerer.
 * - When WICKED_SEAT_SHELL is set, pi's bash tool is replaced by one that runs the guard shell.
 * - Load and turn-end records go to WICKED_SEAT_GATE_SOCKET. Observability only.
 */
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.2.0';

/** The fixed block reasons. `headless` and `tooLarge` are contract text; the rest are pinned by tests. */
export const REASONS = Object.freeze({
  headless: 'tools are off in headless mode',
  tooLarge: 'action too large to review',
  denied: 'pi-governance: the operator denied this call',
  cancelled: 'pi-governance: the permission dialog was cancelled',
  timeout: 'pi-governance: no answer before the timeout',
  error: 'pi-governance: the permission dialog failed',
  guard: 'pi-governance: the guard shell could not be installed',
});

export const DEFAULT_TIMEOUT_MS = 600_000;
/** Strings longer than this many UTF-8 bytes are replaced by `{bytes, sha256}`. */
export const STRING_LIMIT = 256;
/** The dialog budget: the engine's pane is 250x80; chrome (border, title, buttons, padding) is reserved. */
export const PANE = Object.freeze({ cols: 250, rows: 80, chromeCols: 8, chromeRows: 14 });

/**
 * Replace each string over `limit` UTF-8 bytes with `{bytes, sha256}`. Pure: the input is not mutated.
 * @param {unknown} value
 */
export function reduce(value, limit = STRING_LIMIT) {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= limit) return value;
    return { bytes, sha256: createHash('sha256').update(value, 'utf8').digest('hex') };
  }
  if (Array.isArray(value)) return value.map((v) => reduce(v, limit));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reduce(v, limit)]));
  }
  return value;
}

const ZERO_WIDTH = /^[\p{M}\p{Cf}\p{Cc}]$/u;
// Emoji are counted wide (erring wide only makes the budget stricter); the rest is East Asian
// Wide/Fullwidth.
const WIDE = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]$/u;

/** Terminal cells for one character: 0 for combining/format/control, 2 for wide or emoji, else 1. */
function cellWidth(ch) {
  if (ZERO_WIDTH.test(ch)) return 0;
  return WIDE.test(ch) ? 2 : 1;
}

/** Display width of `text` in terminal cells. */
export function displayWidth(text) {
  let w = 0;
  for (const ch of text) w += cellWidth(ch);
  return w;
}

/**
 * Whether `title` + `line` fit the dialog's budget. The line is soft-wrapped, so rows are cells
 * divided by usable columns, rounded up, with one spare row for a wide character that straddles a
 * wrap point. The title and dialog buttons are covered by the reserved chrome rows.
 */
export function fits(line, pane = PANE) {
  const cols = pane.cols - pane.chromeCols;
  const maxRows = pane.rows - pane.chromeRows;
  const rows = Math.ceil(displayWidth(line) / cols) + 1;
  return rows <= maxRows;
}

/**
 * The permission question for one tool call. `line` is one compact JSON line; newlines inside
 * values are JSON-escaped, so it never spans lines.
 * @param {{ toolName: string, input?: unknown }} event
 */
export function envelope(event) {
  const tool = String(event?.toolName ?? '');
  return { title: tool, line: JSON.stringify({ v: 2, tool, input: reduce(event?.input ?? null) }) };
}

/** Race `work` against a timer; `onExpire` runs on timeout (to close the pending dialog). */
function withTimeout(work, ms, onExpire) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT); // settle first: an abort-triggered rejection must not win the race
      onExpire();
    }, ms);
  });
  Promise.resolve(work).catch(() => {}); // a rejection after expiry is not an unhandled one
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
const TIMED_OUT = Symbol('timed out');

/** Keep only the question's answer from confirm/input; settled exactly once, late answers are dropped. */
async function ask(call, ms) {
  const ac = new AbortController();
  try {
    const answer = await withTimeout(call(ac.signal), ms, () => ac.abort());
    return answer === TIMED_OUT ? { timedOut: true } : { answer };
  } catch (err) {
    return { failed: err };
  }
}

const block = (reason) => ({ block: true, reason });

/**
 * Decide one tool call: `undefined` lets it run, else pi's block result.
 * @param {{ toolName: string, input?: unknown }} event
 * @param {{ hasUI?: boolean, ui?: { confirm?: Function, input?: Function } }} ctx
 * @param {{ timeoutMs?: number, pane?: typeof PANE }} [opts]
 */
export async function decide(event, ctx, opts = {}) {
  if (!ctx?.hasUI || typeof ctx?.ui?.confirm !== 'function') return block(REASONS.headless);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { title, line } = envelope(event);
  if (!fits(line, opts.pane)) return block(REASONS.tooLarge);

  const first = await ask((signal) => ctx.ui.confirm(title, line, { signal, timeout: timeoutMs }), timeoutMs);
  if (first.timedOut) return block(REASONS.timeout);
  if (first.failed) return block(REASONS.error);
  if (first.answer === true) return undefined;
  // Anything but a boolean `false` is not a considered no: a cancel the API reports as undefined.
  if (first.answer !== false) return block(REASONS.cancelled);

  if (typeof ctx.ui.input !== 'function') return block(REASONS.denied);
  const second = await ask((signal) => ctx.ui.input('Reason for denying', '', { signal, timeout: timeoutMs }), timeoutMs);
  if (second.timedOut) return block(REASONS.timeout);
  if (second.failed) return block(REASONS.error);
  if (typeof second.answer !== 'string') return block(REASONS.cancelled);
  return block(second.answer.trim() === '' ? REASONS.denied : second.answer);
}

/** Send one JSON record over the gate socket. Never throws; resolves within `waitMs`. */
export function notify(record, socketPath = process.env.WICKED_SEAT_GATE_SOCKET, waitMs = 1000) {
  if (!socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const sock = createConnection(socketPath);
    const timer = setTimeout(() => finish(false), waitMs);
    sock.on('error', () => finish(false));
    sock.on('connect', () => sock.end(JSON.stringify(record) + '\n', () => finish(true)));
  });
}

/** pi's own package exports the bash tool and the operations factory; the name changed across versions. */
const PI_PACKAGES = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'];

/** The directory of pi's own install, found by walking up from the running pi binary. */
function piInstallDir() {
  try {
    let dir = dirname(realpathSync(process.argv[1]));
    for (let i = 0; i < 8; i += 1, dir = dirname(dir)) {
      const pj = join(dir, 'package.json');
      if (existsSync(pj) && PI_PACKAGES.includes(JSON.parse(readFileSync(pj, 'utf8')).name)) return dir;
    }
  } catch {
    /* not found */
  }
  return undefined;
}

/**
 * Load pi's exports. A bare import from this file may not resolve (the extension lives outside pi's
 * node_modules), so fall back to pi's own install directory, found from the running binary.
 */
async function loadPi() {
  const usable = (mod) => typeof mod?.createBashTool === 'function' && typeof mod?.createLocalBashOperations === 'function';
  const errors = [];
  for (const name of PI_PACKAGES) {
    try {
      const mod = await import(name);
      if (usable(mod)) return mod;
    } catch (err) {
      errors.push(`${name}: ${err?.message}`);
    }
  }
  const dir = piInstallDir();
  if (dir) {
    try {
      const pj = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      let file;
      try {
        file = createRequire(pj).resolve(pkg.name);
      } catch {
        const dot = pkg.exports?.['.'];
        file = resolve(dir, (typeof dot === 'string' ? dot : dot?.import ?? dot?.default) ?? pkg.module ?? pkg.main ?? 'index.js');
      }
      const mod = await import(pathToFileURL(file).href);
      if (usable(mod)) return mod;
      errors.push(`${file}: createBashTool/createLocalBashOperations missing`);
    } catch (err) {
      errors.push(`${dir}: ${err?.message}`);
    }
  }
  throw new Error(errors.join('; ') || 'pi exports not found');
}

/**
 * The extension factory. `options.timeoutMs` exists for tests; pi calls the factory with `pi` only,
 * so nothing the seat controls can change the production timeout.
 */
export default async function piGovernance(pi, options = {}) {
  const shell = process.env.WICKED_SEAT_SHELL;
  let guardFailed;
  if (shell) {
    try {
      const mod = await loadPi();
      pi.registerTool(mod.createBashTool(process.cwd(), { operations: mod.createLocalBashOperations({ shellPath: shell }) }));
    } catch (err) {
      guardFailed = `${REASONS.guard}: ${err?.message ?? err}`; // fail closed: bash is blocked rather than run unguarded
    }
  }

  pi.on('tool_call', (event, ctx) => {
    if (!ctx?.hasUI) return block(REASONS.headless); // headless wins over a guard failure
    if (guardFailed && event?.toolName === 'bash') return block(guardFailed);
    return decide(event, ctx, options);
  });
  pi.on('session_start', () => notify({ ext: 'pi-governance', version: VERSION }, options.socketPath));
  pi.on('agent_end', () => notify({ ext: 'pi-governance', event: 'turn-end' }, options.socketPath));
}
