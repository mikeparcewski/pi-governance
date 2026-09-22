/** Fold the per-scenario summaries into one. Fails loudly if a scenario is missing. */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const EXPECTED = [
  'composed-allow',
  'composed-deny-write',
  'composed-cancel-write',
  'composed-negative-control',
  'composed-parallel-allow',
  'composed-parallel-deny-b',
];
const checks = [];
const scenarios = [];
let meta = null;
for (const name of EXPECTED) {
  const path = join(dir, `summary-${name}.json`);
  if (!existsSync(path)) {
    console.error(`AGGREGATE FAILED: missing ${path}`);
    process.exit(1);
  }
  const s = JSON.parse(readFileSync(path, 'utf8'));
  if (s.checks.length === 0 || s.scenarios.length !== 1) {
    console.error(`AGGREGATE FAILED: ${name} summary is empty or malformed`);
    process.exit(1);
  }
  meta ??= { pi: s.pi, piPath: s.piPath, carrier: s.carrier, node: s.node, platform: s.platform, piGovernanceCommit: s.piGovernanceCommit };
  checks.push(...s.checks);
  scenarios.push({ ...s.scenarios[0], capturedAt: s.capturedAt });
}
const failed = checks.filter((c) => !c.ok);
const out = { ...meta, totalChecks: checks.length, failedChecks: failed.length, checks, scenarios };
writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(out, null, '\t')}\n`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.scenario}  ${c.id}  ${c.detail}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed across ${scenarios.length} scenarios`);
