/**
 * Copy the capture evidence into the repo, redacting machine-local absolute paths.
 * Anything that still matches the redaction patterns after the copy aborts the bundle.
 */
import { cpSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , srcArg, destArg] = process.argv;
const src = resolve(srcArg);
const dest = resolve(destArg);
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

const SCRATCH = resolve(src, '..');
const PIGOV_CHECKOUT = resolve(SCRATCH, '..', 'pigov', 'pi-governance');
const HOME = process.env.HOME;
const REDACTIONS = [
  [PIGOV_CHECKOUT, '<PI-GOVERNANCE-CHECKOUT>'],
  [SCRATCH, '<CAPTURE-WORKDIR>'],
  [HOME, '<HOME>'],
];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    let text = readFileSync(path, 'utf8');
    let changed = false;
    for (const [from, to] of REDACTIONS) {
      if (!from) continue;
      // JSON-encoded copies escape nothing on POSIX, but redact both spellings anyway.
      for (const spelling of [from, JSON.stringify(from).slice(1, -1)]) {
        if (text.includes(spelling)) {
          text = text.split(spelling).join(to);
          changed = true;
        }
      }
    }
    if (changed) writeFileSync(path, text);
  }
}
walk(dest);

// Fail loudly if anything machine-local survived.
const BANNED = [HOME, SCRATCH, PIGOV_CHECKOUT, HOME ? HOME.split('/').pop() : null, SCRATCH.split('/')[2]].filter(Boolean);
let leaks = 0;
function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      scan(path);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    for (const pattern of BANNED) {
      if (text.includes(pattern)) {
        leaks += 1;
        console.error(`LEAK in ${path.slice(dest.length + 1)} (pattern #${BANNED.indexOf(pattern)})`);
      }
    }
  }
}
scan(dest);
if (leaks > 0) {
  console.error(`BUNDLE FAILED: ${leaks} leak(s)`);
  process.exit(1);
}
console.log(`bundled ${dest} with 0 leaks`);
