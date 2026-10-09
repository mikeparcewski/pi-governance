#!/usr/bin/env node
/**
 * The command pi-acp runs as pi during a capture (`PI_ACP_PI_COMMAND`). With PI_GOV_GATE=1 it
 * loads only this repo's extension (`--no-extensions -e <gate>`); without it pi starts bare, which
 * reproduces the ungoverned baseline. Every other argument (pi-acp's `--mode rpc --no-themes`)
 * passes through unchanged.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// PI_GOV_GATE_PATH points at a different gate file, used to check that a broken gate fails the capture.
const gate = process.env.PI_GOV_GATE_PATH || fileURLToPath(new URL('../../extensions/pi-governance.js', import.meta.url));
const pre = process.env.PI_GOV_GATE === '1' ? ['--no-extensions', '-e', gate] : ['--no-extensions'];
const child = spawn(process.env.PI_GOV_PI_BINARY || 'pi', [...pre, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
