/**
 * A scripted OpenAI Chat Completions server on loopback. No model, no account, no network.
 *
 * Each request is answered with the step at index = assistant messages already in the request, so a
 * tool round-trip advances the script. A step is `{tool, args}` (one streamed tool call) or
 * `{text}`. Every complete request body is kept in `requests`, so a test can read exactly what pi
 * sent as the user message or the tool result.
 */
import { createServer } from 'node:http';

export function startStub(steps) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !/chat\/completions$/.test(req.url ?? '')) return res.writeHead(404).end();
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* recorded empty */ }
      requests.push(body);
      const turns = (body.messages ?? []).filter((m) => m.role === 'assistant').length;
      const step = steps[Math.min(turns, steps.length - 1)];
      const id = `chatcmpl-stub-${requests.length}`;
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model ?? 'mock-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (step.tool) {
        res.write(chunk({ role: 'assistant', content: null }));
        res.write(chunk({ tool_calls: [{ index: 0, id: `call_stub_${requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: step.text ?? 'done' }));
        res.write(chunk({}, 'stop'));
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      })));
}
