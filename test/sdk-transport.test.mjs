import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiWebTools } from '../src/pi-web-tools.mjs';
import { piCatalog, piBinding, PiModelRuntime } from '../src/pi-runtime.mjs';
import { createPiModelAdapter } from '../src/pi-model-adapter.mjs';
import { createPinnedModelFetch } from '../src/model-transport.mjs';
import { messageResponse } from './sdk-test-helpers.mjs';

const snapshot = { connections: [{ id: 'gateway', providerId: 'bailian', protocol: 'anthropic-messages',
  authMode: 'x-api-key', apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic', apiKey: 'synthetic-provider-key' }],
  models: [{ id: 'qwen', actualModel: 'qwen3.8-max[200k]', connectionId: 'gateway' }] };

test('Pi retains the public context selector and puts the bound key only in the upstream header', async () => {
  const [model] = piCatalog(snapshot);
  assert.deepEqual(model.efforts, ['low', 'medium', 'xhigh']);
  assert.equal(JSON.stringify(model).includes('synthetic-provider-key'), false);
  assert.equal(createPiModelAdapter(piBinding(model)).model.contextWindow, 200000);
  let calls = 0;
  const runtime = new PiModelRuntime({ fetch: async (url, init) => {
    assert.equal(url, snapshot.connections[0].apiBase + '/v1/messages');
    assert.equal(init.headers['x-api-key'], snapshot.connections[0].apiKey);
    assert.ok(!init.body.includes(snapshot.connections[0].apiKey));
    assert.equal(JSON.parse(init.body).model, 'qwen3.8-max');
    calls++;
    return messageResponse({ type: 'text', text: 'OK' }, 'end_turn');
  } });
  assert.equal((await runtime.validateAllEnabled(snapshot)).checked, 1);
  assert.equal(calls, 1);
});

test('Pi probes reject private DNS before connecting and sanitize diagnostics', async () => {
  let attempts = 0;
  const fetch = createPinnedModelFetch({ lookup: async () => [{address: '127.0.0.1', family: 4}],
    httpsRequest: () => { attempts++; throw Error('unexpected request'); } });
  await assert.rejects(new PiModelRuntime({ fetch }).validateAllEnabled(snapshot), (e) =>
    e.code === 'LLM_VALIDATION_FAILED' && !JSON.stringify(e.results).includes(snapshot.connections[0].apiKey));
  assert.equal(attempts, 0);
});

test('task-scoped web tools enforce the search result allowlist, release leases and stay out of learning reviews', async () => {
  const task = { webSearch: true, abortController: new AbortController() };
  const config = { enabled: true, provider: 'tavily-rest' };
  let closed = false;
  const url = 'https://example.org/note';
  const web = await createPiWebTools(task, config, { search: {
    searchMany: async () => ({ results: [{ url, id: 's1' }] }), close: () => { closed = true; },
  }, reader: { readMany: async (args) => ({ documents: args.sources }) } });
  const [search, extract] = web.tools;
  assert.equal(search.name, 'web_search');
  await assert.rejects(extract.execute('a', { urls: [url] }), /本任务/);
  await search.execute('b', {query: 'note'});
  assert.equal((await extract.execute('c', {urls: [url]})).details.documents[0].id, 's1');
  await web.close();
  assert.ok(closed);
  assert.deepEqual((await createPiWebTools({...task, learningReview: {}}, config)).tools, []);
  assert.deepEqual((await createPiWebTools({...task, webSearch: false}, config)).tools, []);
});
