import http from 'node:http';
import { once } from 'node:events';

export function completion(text, calls = [], reasoning = '', usage) {
  const frames = [];
  const add = (delta, stop = null) => frames.push('data: ' + JSON.stringify({ id: 'mock-response',
    object: 'chat.completion.chunk', model: 'mock', choices: [{index: 0, delta, finish_reason: stop}] }) + '\n\n');
  add({role: 'assistant'});
  for (const part of Array.isArray(reasoning) ? reasoning : [reasoning]) if (part) add({reasoning_content: part});
  if (calls.length) add({ tool_calls: calls.map(([name, args], index) => ({ index, id: 'id-' + index, type: 'function',
    function: { name, arguments: JSON.stringify(args) } })) });
  for (const chunk of Array.isArray(text) ? text : [text]) if (chunk) add({ content: chunk });
  add({}, calls.length ? 'tool_calls' : 'stop');
  if (usage) frames.push('data: ' + JSON.stringify({choices: [], usage}) + '\n\n');
  return new Response(frames.join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
}

export async function localModel(t, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      const response = await respond(body, req, requests.length);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, url: 'http://127.0.0.1:' + server.address().port };
}
