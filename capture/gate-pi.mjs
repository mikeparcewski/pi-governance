#!/usr/bin/env node
/**
 * The pi binary wicked-pi's `WICKED_PI_BINARY` points at for this proof.
 *
 * It exists only so the gate flags can be injected WITHOUT editing wicked-crew's shim: it
 * prepends `PIPROOF_PI_FLAGS` (a JSON array) to whatever argv it is handed and then runs the
 * real pi. That is the identical shape `composePiArgv` already uses for `--skill` flags
 * (wicked-pi.mjs:43) — in production the flags would come from there, not from here.
 *
 * With `PIPROOF_PI_FLAGS` unset this is a transparent pass-through.
 */
import { spawn } from 'node:child_process';

const extra = JSON.parse(process.env.PIPROOF_PI_FLAGS ?? '[]');
if (!Array.isArray(extra)) {
  console.error('[gate-pi] PIPROOF_PI_FLAGS must be a JSON array');
  process.exit(2);
}
const bin = process.env.PIPROOF_REAL_PI ?? 'pi';
const argv = [...extra, ...process.argv.slice(2)];
if (process.env.PIPROOF_ARGV_LOG) {
  try {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.PIPROOF_ARGV_LOG, `${JSON.stringify([bin, ...argv])}\n`);
  } catch {
    /* logging must never break the run */
  }
}

const child = spawn(bin, argv, { stdio: 'inherit', env: process.env });
const forward = (sig) => () => {
  try {
    child.kill(sig);
  } catch {
    /* already gone */
  }
};
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, forward(sig));
child.on('error', (err) => {
  console.error(`[gate-pi] could not start ${bin}: ${err?.message ?? String(err)}`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  process.exit(code !== null ? code : 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGTERM' ? 15 : 1));
});
