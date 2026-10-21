// Syntax-check every JS/MJS file under extensions/, test/ and scripts/ (nested files included).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(m?js)$/.test(f) ? [p] : [];
  });

let bad = 0;
const files = ['extensions', 'test', 'scripts'].flatMap(walk);
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad += 1; process.stderr.write(r.stderr); }
}
console.log(`lint: ${files.length} files checked, ${bad} failed`);
process.exit(bad ? 1 : 0);
