/**
 * Live tests: pi 1.1.0 interactive in a 250x80 tmux pane, a scripted stub model on loopback, a fake
 * key, and a scratch seat root under os.tmpdir(). No ACP.
 *
 * Without pi or tmux and with CI unset, the five cases skip with one counted stderr line each. With
 * CI set they fail: a green CI run must have run them.
 *
 * UNVERIFIED against a real pi (none was installable where this was written): the dialog's keys
 * (Yes is the default; No is Down then Enter) and the wrapper pi puts around a block reason. The
 * first live run records the wrapper (`wrapper.json` under the notes root); adjust `answerNo` if
 * the keys differ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seat, missing, sleep, until, toolResults, dumpPane } from './harness.mjs';

const lack = missing();
const notes = process.env.WICKED_NOTES_ROOT ? join(process.env.WICKED_NOTES_ROOT, 'pi-tmux') : undefined;
const CASES = 5;
let n = 0;

/** Define one live case; skip (counted) or fail per the CI rule when prerequisites are absent. */
const live = (name, fn) =>
  test(name, { timeout: 180_000 }, async (t) => {
    n += 1;
    if (lack.length) {
      const line = `SKIPPED ${n}/${CASES} tmux tests: ${lack.join(',')} missing`;
      if (process.env.CI) assert.fail(`${line} (CI is set, so this is a failure)`);
      process.stderr.write(`pi-governance: ${line}\n`);
      return t.skip(line);
    }
    await fn(t);
  });

const scratch = () => mkdtempSync(join(tmpdir(), 'pigov-marker-'));
const answerNo = (s) => { s.keys('Down'); s.keys('Enter'); };

/** Run `fn` with a marker path and a seat whose stub asks for `touch <marker>` first. */
async function withSeat(opts, fn) {
  const dir = scratch();
  const marker = join(dir, 'marker');
  const steps = [{ tool: 'bash', args: { command: `touch ${marker}` } }, { text: 'done' }];
  const s = await seat({ notes, ...opts, steps });
  try {
    await fn(s, marker);
  } catch (err) {
    dumpPane(s, err);
    s.save(`failure-${n}.txt`);
    throw err;
  } finally {
    await s.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const submit = (s, text = 'go') => { s.type(text); s.keys('Enter'); };

live('1. a no keeps the command from running', async () => {
  await withSeat({}, async (s, marker) => {
    submit(s);
    const pane = await s.waitDialog('bash');
    assert.match(pane, /touch /);
    answerNo(s);
    await s.waitPane(/[Rr]eason/, 'the reason input');
    s.paste('not today');
    s.keys('Enter');
    await until(() => toolResults(s.stub).length > 0, 'the tool result to reach the stub');
    assert.equal(existsSync(marker), false);
  });
});

live('2. the pasted reason is the tool result the stub receives next', async () => {
  const reason = 'nein: "quoted" \\ back-slash, ünïcödé 日本語 🙂 end';
  await withSeat({}, async (s, marker) => {
    submit(s);
    await s.waitDialog('bash');
    answerNo(s);
    await s.waitPane(/[Rr]eason/, 'the reason input');
    s.paste(reason);
    s.keys('Enter');
    const results = await until(() => { const r = toolResults(s.stub); return r.length ? r : false; }, 'the tool result');
    const hit = results.find((r) => r.includes(reason));
    assert.ok(hit, `no tool result contains the reason byte-for-byte; got ${JSON.stringify(results)}`);
    // Record pi's wrapper, if any, for the report: everything around the reason.
    if (notes) {
      mkdirSync(notes, { recursive: true });
      const [before, after] = hit.split(reason);
      writeFileSync(join(notes, 'wrapper.json'), JSON.stringify({ before, after }));
    }
    assert.equal(existsSync(marker), false);
  });
});

live('3. with no answer the dialog stays up, pi stays alive and nothing runs', async () => {
  await withSeat({}, async (s, marker) => {
    submit(s);
    await s.waitDialog('bash');
    const end = Date.now() + 5_000; // well under the 600 s timeout
    while (Date.now() < end) {
      assert.ok(s.alive(), 'pi must stay alive');
      assert.match(s.pane(), /"tool":"bash"/, 'the dialog must stay visible');
      assert.equal(existsSync(marker), false);
      assert.equal(toolResults(s.stub).length, 0);
      await sleep(500);
    }
    // The stalled call was executable: a yes now runs it.
    s.keys('Enter');
    await until(() => existsSync(marker), 'the marker after a yes');
  });
});

live('4. WICKED_SEAT_SHELL routes bash through the guard, which refuses', async () => {
  const dir = scratch();
  const log = join(dir, 'guard.log');
  const guard = join(dir, 'guard.sh');
  writeFileSync(guard, `#!/bin/sh\necho "guard: $*" >> "${log}"\nexit 126\n`);
  chmodSync(guard, 0o755);
  try {
    await withSeat({ extraEnv: { WICKED_SEAT_SHELL: guard } }, async (s, marker) => {
      const settingsPath = join(s.agent, 'settings.json');
      const before = readFileSync(settingsPath, 'utf8');
      assert.equal(JSON.parse(before).shellPath, undefined);
      submit(s);
      await s.waitDialog('bash');
      s.keys('Enter'); // yes
      await until(() => existsSync(log), 'the guard log');
      assert.match(readFileSync(log, 'utf8'), /guard: .*touch /);
      await until(() => toolResults(s.stub).length > 0, 'the failed tool result');
      assert.equal(existsSync(marker), false);
      assert.equal(readFileSync(settingsPath, 'utf8'), before);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

live('5. a 70,000-byte single-line paste reaches the stub with the same sha256', async () => {
  const unit = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  const prompt = unit.repeat(Math.ceil(70_000 / unit.length)).slice(0, 70_000);
  assert.equal(Buffer.byteLength(prompt), 70_000);
  const want = createHash('sha256').update(prompt).digest('hex');
  const s = await seat({ notes, steps: [{ text: 'ok' }] });
  try {
    s.paste(prompt);
    await sleep(500);
    s.keys('Enter');
    const req = await until(() => s.stub.requests.at(-1), 'the stub to receive the prompt', 60_000);
    const user = req.messages.filter((m) => m.role === 'user').at(-1);
    const text = typeof user.content === 'string' ? user.content : user.content.map((p) => p.text ?? '').join('');
    assert.equal(Buffer.byteLength(text), 70_000);
    assert.equal(createHash('sha256').update(text).digest('hex'), want);
  } catch (err) {
    dumpPane(s, err);
    s.save('failure-5.txt');
    throw err;
  } finally {
    await s.dispose();
  }
});
