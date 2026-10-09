/**
 * A scripted OpenAI Chat Completions endpoint for offline captures. No real model, no account.
 *
 * Each request answers with the step at index = number of assistant messages already in the
 * request (so a tool round-trip advances the script). A step is either
 *   { tool: '<name>', args: {...} }  -> one streamed tool call, finish_reason "tool_calls"
 *   { text: '...' }                  -> a streamed text answer, finish_reason "stop"
 * Every request body is appended to `log` (one JSON line each) so a capture can show what the
 * agent sent, including the tool schemas it offered.
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

export function startMock({ steps, log }) {
  let served = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !/chat\/completions$/.test(req.url ?? '')) {
        res.writeHead(404).end();
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* logged as-is below */
      }
      const assistantTurns = (body.messages ?? []).filter((m) => m.role === 'assistant').length;
      const step = steps[Math.min(assistantTurns, steps.length - 1)];
      served += 1;
      if (log) {
        appendFileSync(
          log,
          JSON.stringify({
            at: new Date().toISOString(),
            assistantTurns,
            step,
            tools: (body.tools ?? []).map((t) => t.function?.name),
            lastMessage: (body.messages ?? []).at(-1),
          }) + '\n',
        );
      }
      const id = `chatcmpl-mock-${served}`;
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? 'mock-1',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (step.tool) {
        res.write(chunk({ role: 'assistant', content: null }));
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_mock_${served}`,
                type: 'function',
                function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: step.text ?? 'done' }));
        res.write(chunk({}, 'stop'));
      }
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
