/**
 * Copy a capture's output into the repo's `evidence/` tree, redacting machine-local
 * absolute paths on the way.
 *
 *   node capture/bundle.mjs <capture-out-dir> evidence/<dated-dir>
 *
 * Anything that still matches a banned pattern after the copy aborts the bundle, so a
 * checkout path or a home directory cannot ride into a commit unnoticed.
 */
import { cpSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , srcArg, destArg] = process.argv;
if (!srcArg || !destArg) {
  console.error('usage: node capture/bundle.mjs <capture-out-dir> <evidence-dir>');
  process.exit(2);
}
const src = resolve(srcArg);
const dest = resolve(destArg);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME;
const TMP = tmpdir();

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

const REDACTIONS = [
  [REPO, '<PI-GOVERNANCE-CHECKOUT>'],
  [src, '<CAPTURE-OUT>'],
  [TMP, '<TMP>'],
  [HOME, '<HOME>'],
];

function eachFile(dir, visit) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      eachFile(path, visit);
      continue;
    }
    visit(path);
  }
}

eachFile(dest, (path) => {
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
});

// Fail loudly if anything machine-local survived.
const BANNED = [HOME, src, REPO, TMP, HOME ? basename(HOME) : null, '/Users/', '/private/tmp/'].filter(Boolean);
let leaks = 0;
eachFile(dest, (path) => {
  const text = readFileSync(path, 'utf8');
  for (const pattern of BANNED) {
    if (text.includes(pattern)) {
      leaks += 1;
      console.error(`LEAK in ${path.slice(dest.length + 1)} (pattern #${BANNED.indexOf(pattern)})`);
    }
  }
});
if (leaks > 0) {
  console.error(`BUNDLE FAILED: ${leaks} leak(s)`);
  process.exit(1);
}
console.log(`bundled ${dest} with 0 leaks`);
