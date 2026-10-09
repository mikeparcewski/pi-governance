import { test } from 'node:test';
import assert from 'node:assert/strict';
import piGovernance, { decide, envelope, ENVELOPE_KEY, ENVELOPE_VERSION } from '../extensions/pi-governance.js';

const rpcCtx = (answer) => {
  const asked = [];
  return {
    asked,
    ctx: {
      hasUI: true,
      mode: 'rpc',
      ui: {
        confirm: async (title, message) => {
          asked.push({ title, message });
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    },
  };
};

const write = { toolName: 'write', toolCallId: 'call_1', input: { path: '/w/a.txt', content: 'x' } };

test('every built-in tool asks, with the bare tool name as the title', async () => {
  for (const toolName of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']) {
    const { ctx, asked } = rpcCtx(true);
    assert.equal(await decide({ toolName, toolCallId: 't', input: {} }, ctx), undefined);
    assert.equal(asked.length, 1, toolName);
    assert.equal(asked[0].title, toolName);
  }
});

test('the message is a versioned envelope carrying the real arguments', () => {
  const { title, message } = envelope(write);
  assert.equal(title, 'write');
  assert.deepEqual(JSON.parse(message), {
    [ENVELOPE_KEY]: ENVELOPE_VERSION,
    toolCallId: 'call_1',
    toolName: 'write',
    input: { path: '/w/a.txt', content: 'x' },
  });
});

test('only an explicit yes lets the call run', async () => {
  for (const answer of [false, undefined, null, 'yes', 1]) {
    const { ctx } = rpcCtx(answer);
    const r = await decide(write, ctx);
    assert.equal(r?.block, true, String(answer));
    assert.match(r.reason, /did not allow `write`/);
  }
});

test('a dialog that throws is a deny', async () => {
  const { ctx } = rpcCtx(new Error('pipe closed'));
  const r = await decide(write, ctx);
  assert.equal(r.block, true);
  assert.match(r.reason, /failed \(pipe closed\)/);
});

test('a mode with no permission channel denies every call', async () => {
  for (const ctx of [{ hasUI: false, mode: 'print' }, { hasUI: false, mode: 'json' }, {}, undefined]) {
    const r = await decide(write, ctx);
    assert.equal(r.block, true);
    assert.match(r.reason, /no permission channel/);
  }
});

test('the factory registers exactly one tool_call handler', async () => {
  const on = [];
  piGovernance({ on: (name, fn) => on.push([name, fn]) });
  assert.deepEqual(on.map(([n]) => n), ['tool_call']);
  const { ctx } = rpcCtx(false);
  assert.equal((await on[0][1](write, ctx)).block, true);
});
