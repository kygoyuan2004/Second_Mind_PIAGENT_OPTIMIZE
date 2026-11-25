import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { executePiTask, compactContext } from '../src/pi-agent-executor.mjs';
import { createVaultTools, safeSearchResults } from '../src/pi-vault-tools.mjs';
import { createPiModelAdapter } from '../src/pi-model-adapter.mjs';
import { PiModelRuntime, piCatalog, piBinding } from '../src/pi-runtime.mjs';
import { messageResponse, sdkApplication } from './sdk-test-helpers.mjs';

import { completion, localModel } from './support/loopback-chat.mjs';

async function fixture(t, opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-loop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'Note.md'), '# Evidence\nfirst\nsecond\nthird\nfourth\n');
  const task = { id: 'parent', kind: 'qa', prompt: '检查笔记', taskPrompt: '检查笔记', attachments: [],
    videoFrames: [], candidates: [], model: { id: 'fixture', actualModel: 'fixture' }, effort: { id: 'default' },
    taskMode: { id: 'normal', maxTurns: 20 }, abortController: new AbortController(),
    subagentsEnabled: true, executionStartedAt: Date.now(), ...opts };
  const events = [];
  const manager = { store: { root, config: { excludedPaths: ['excluded'] } }, emitRetrievalEmbedding() {},
    emit: (_task, type, data) => events.push({ type, data }), emitAnswerText: (_task, text) => events.push({ type: 'text', data: { text } }) };
  return { root, task, manager, events };
}

const binding = (apiBase) => ({ providerId: 'custom', protocol: 'openai-chat-completions', authMode: 'none', apiBase, model: 'fixture' });
const run = (f, b) => executePiTask(f.manager, f.task, { messages: [] }, b);
const parseResult = (m) => JSON.parse(m.content);

test('OpenAI loop reads, recovers from an incorrect citation line and filters a streamed forged marker', async (t) => {
  const f = await fixture(t);
  let citation;
  const endpoint = await localModel(t, (body, req, n) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined);
    const last = body.messages.at(-1);
    if (n === 1) return completion('', [['read_note_lines', {path: 'Note.md', startLine: 2, limit: 2}]], ['想', '一', '想'],
      { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: {cached_tokens: 30},
        completion_tokens_details: {reasoning_tokens: 10} });
    if (n === 2) {
      assert.equal(parseResult(last).text, '2│ first\n3│ second');
      return completion('', [['cite_passage', {path: 'Note.md', line: 2, quote: 'second'}]]);
    }
    if (n === 3) {
      assert.match(last.content, /逐字|起始行/);
      return completion('', [['cite_passage', {path: 'Note.md', line: 3, quote: 'second'}]]);
    }
    citation = last.content;
    assert.match(citation, /^〔依据：[a-f0-9]{16}〕$/);
    return completion(['已核实', citation.slice(0, 4), citation.slice(4), '〔依', '据：aaaaaaaaaaaaaaaa〕'], [], '', {prompt_tokens: 185, completion_tokens: 36});
  });
  const result = await run(f, binding(endpoint.url + '/v1'));
  assert.equal(result.num_turns, 4);
  assert.deepEqual(f.task.modelUsage, {modelCalls: 4, reportedCalls: 2, inputTokens: 305, outputTokens: 51});
  assert.deepEqual(f.events.filter((e) => e.type === 'thinking').map((e) => e.data.turn), [1]);
  assert.ok(!JSON.stringify(f.events).includes('estimatedTokens'));
  assert.equal(f.events.filter((e) => e.type === 'text').map((e) => e.data.text).join(''), '已核实' + citation);
  assert.equal(f.task.evidence.size, 1);
  assert.equal(f.task.evidence.values().next().value.line, 3);
  assert.deepEqual(endpoint.requests[0].tools, endpoint.requests[3].tools);
  assert.ok(endpoint.requests[0].tools.length >= 8);
});

for (const [providerId, model, apiBase] of [['deepseek', 'deepseek-reasoner', 'https://api.deepseek.com/v1'],
  ['kimi', 'kimi-k3', 'https://api.moonshot.cn/v1']]) {
  test(providerId + ' replays reasoning_content with a tool call in the next real provider request', async (t) => {
    const f = await fixture(t);
    const endpoint = await localModel(t, (_body, _req, n) => n === 1
      ? completion('', [['read_note_outline', {path: 'Note.md'}]], 'private chain fixture') : completion('done'));
    f.manager.transportFetch = (_url, init) => fetch(endpoint.url, init);
    f.task.effort.id = 'high';
    await run(f, { ...binding(apiBase), providerId, model, authMode: 'bearer', apiKey: 'synthetic-replay-key' });
    const body = endpoint.requests[1];
    assert.equal(body.messages.find((m) => m.tool_calls?.length).reasoning_content, 'private chain fixture');
    assert.equal(body.reasoning_effort, 'high');
    assert.ok(!JSON.stringify(f.events).includes('private chain fixture'));
  });
}

test('same-turn tool calls overlap with a peak of six active reads and ordered results', async (t) => {
  const f = await fixture(t);
  let active = 0, peak = 0;
  f.manager.store.hybridSearch = async (query) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return { route: query, results: [] };
  };
  const queries = Array.from({length: 12}, (_, i) => 'query' + i);
  const endpoint = await localModel(t, (_body, _req, n) => n === 1
    ? completion('', queries.map((query) => ['knowledge_search', { query }])) : completion('done'));
  await run(f, binding(endpoint.url));
  assert.equal(peak, 6);
  assert.deepEqual(endpoint.requests[1].messages.filter((m) => m.role === 'tool').map((m) => parseResult(m).route), queries);
});

test('learning review admits forty calls and sends exactly one authoritative correction', async (t) => {
  const f = await fixture(t, { learningReview: {}, webSearch: false, taskMode: {id: 'normal', maxTurns: 50} });
  const endpoint = await localModel(t, (_body, _req, n) => n === 1
    ? completion('', Array.from({length: 41}, () => ['glob_notes', {}])) : completion(n === 2 ? '已全部阅读。' : '正文尚未阅读。未读 1。'));
  await run(f, binding(endpoint.url));
  assert.equal(f.task.learningReviewToolBudget.calls, 40);
  assert.equal(endpoint.requests.length, 3);
  const results = endpoint.requests[1].messages.filter((m) => m.role === 'tool');
  assert.equal(results.length, 41);
  assert.equal(results.filter((m) => m.content.startsWith('请停止检索')).length, 1);
  assert.match(JSON.stringify(endpoint.requests[2].messages.at(-1)), /unreadCount/);
  assert.ok(!JSON.stringify(f.events).includes('已全部阅读'));
  assert.match(f.events.findLast((event) => event.type === 'text').data.text, /未读 1/);
});

test('a learning review uses its last available turn to correct coverage after tool calls', async (t) => {
  const f = await fixture(t, {learningReview: {}, taskMode: {id: 'normal', maxTurns: 3}});
  const endpoint = await localModel(t, (_body, _req, n) => n < 3
    ? completion('', [['glob_notes', {}]]) : completion('未读 1。'));
  await run(f, binding(endpoint.url));
  assert.equal(endpoint.requests.length, 3);
  assert.ok(endpoint.requests.at(-1).messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('真实覆盖计数')));
  assert.equal(f.events.filter((e) => e.type === 'warning').length, 1);
});

test('child roles have isolated transcripts, share verified evidence, and cannot delegate or use web tools', async (t) => {
  const f = await fixture(t, { prompt: '跨多个文档进行核查', taskPrompt: 'parent-private-sentinel',
    taskMode: {id: 'deep', maxTurns: 50} });
  const endpoint = await localModel(t, (body) => {
    const user = body.messages.find((m) => m.role === 'user').content;
    const results = body.messages.filter((m) => m.role === 'tool');
    if (JSON.stringify(user).includes('parent-private-sentinel')) {
      if (results.length) return completion('父结论' + results[0].content);
      return completion('', [['vault-researcher', {question: 'research'}], ['source-verifier', {question: 'verify'}],
        ['source-verifier', {question: 'third'}]]);
    }
    assert.doesNotMatch(JSON.stringify(body), /parent-private-sentinel/);
    assert.ok(!body.tools.some((t) => /researcher|verifier|web_/.test(t.function.name)));
    return results.length ? completion('子结论' + results[0].content) : completion('', [['cite_passage', {path: 'Note.md', line: 3, quote: 'second'}]]);
  });
  await run(f, binding(endpoint.url));
  assert.equal(endpoint.requests.length, 6);
  assert.deepEqual(f.task.modelUsage, {modelCalls: 6, reportedCalls: 0});
  assert.equal(f.task.evidence.size, 1);
  assert.match(f.events.findLast((event) => event.type === 'text').data.text, /父结论子结论〔依据：[a-f0-9]{16}〕/);
  assert.match(JSON.stringify(endpoint.requests.at(-1).messages.at(-1)), /最多两个/);
});

test('line coverage merges adjacent/overlapping reads, preserves outline hierarchy and excludes inaccessible paths', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'dir'));
  await fs.writeFile(path.join(f.root, 'dir', 'Long.md'), '# top\n' + 'abc\n'.repeat(200) + '## detail\nend');
  await fs.writeFile(path.join(f.root, 'Empty.md'), '');
  for (const name of ['.obsidian', 'node_modules', 'excluded']) {
    await fs.mkdir(path.join(f.root, name));
    await fs.writeFile(path.join(f.root, name, 'hidden.md'), 'private');
  }
  await fs.symlink(path.join(f.root, 'dir'), path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = await createVaultTools(f.manager.store, f.task);
  const call = async (name, input = {}) => (await tools.find((tool) => tool.name === name).execute('id', input)).details;
  assert.equal((await call('glob_notes')).total, 3);
  const file = { path: 'dir/Long.md' };
  const tree = await call('read_note_outline', file);
  assert.deepEqual([tree.headings[0].startLine, tree.headings[0].endLine], [1, 203]);
  assert.equal(tree.headings[0].children[0].startLine, 202);
  assert.deepEqual((await call('read_note_lines', {...file, startLine: 4, limit: 200})).remainingRanges, [[1, 3]]);
  assert.equal((await call('read_note_lines', {...file, limit: 10})).complete, true);
  await call('read_note_lines', {path: 'Empty.md'});
  assert.equal((await call('get_reading_coverage')).fullReadCount, 2);
  assert.equal((await call('get_reading_coverage')).unreadCount, 1);
  assert.deepEqual(await call('resolve_wikilink', {fromPath: 'dir/Long.md', reference: '[ref](../Note.md)'}), {path: 'Note.md'});
  assert.deepEqual(await call('resolve_wikilink', {fromPath: 'Note.md', reference: '[[Long#detail|title]]'}), {path: 'dir/Long.md'});
  assert.equal((await call('grep_notes', {pattern: '^seco', isRegex: true}))[0].line, 3);
  await assert.rejects(call('grep_notes', {pattern: '[', isRegex: true}), /正则/);
  for (const path of ['../Note.md', '/Note.md', '.obsidian/hidden.md', 'excluded/hidden.md', 'link/Long.md']) {
    await assert.rejects(call('read_note_lines', {path}));
    await assert.rejects(call('cite_passage', {path, quote: 'abc', line: 2}));
  }
  const relatedPaths = ['dir/Long.md', '.obsidian/hidden.md', 'excluded/hidden.md', 'link/Long.md'];
  const safe = await safeSearchResults(f.task.pathPolicy, [
    {path: '/Note.md'}, {path: 'Note.md', relatedPaths, privateMetadata: 'omit'},
  ]);
  assert.deepEqual(safe.map((item) => item.path), ['Note.md']);
  assert.deepEqual(safe[0].relatedPaths, ['dir/Long.md']);
  assert.equal(safe[0].privateMetadata, undefined);
  await fs.writeFile(path.join(f.root, 'dir/Long.md'), '中'.repeat(12000));
  await assert.rejects(call('read_note_lines', file), /32 KiB/);
  assert.equal((await call('get_reading_coverage')).failedCount, 1);
});

test('a large note can be read past a multi-megabyte line without claiming it as read', async (t) => {
  const f = await fixture(t);
  const name = 'Long.md';
  await fs.writeFile(path.join(f.root, name), 'x'.repeat(2 * 1024 * 1024 + 1) + '\r\n中间\r\n# End\n');
  const tools = await createVaultTools(f.manager.store, f.task);
  const call = async (tool, args) => (await tools.find((item) => item.name === tool).execute('id', args)).details;
  assert.deepEqual((await call('read_note_outline', {path: name})).headings.map((h) => h.startLine), [3]);
  const part = await call('read_note_lines', {path: name, startLine: 2});
  assert.equal(part.text, '2│ 中间\n3│ # End');
  assert.deepEqual(part.remainingRanges, [[1, 1]]);
  assert.deepEqual(await call('grep_notes', {pattern: '中间'}), [{path: name, line: 2, snippet: '中间'}]);
  await assert.rejects(call('read_note_lines', {path: name}), /32 KiB/);
  assert.equal((await call('get_reading_coverage', {})).failedCount, 1);
});

test('compression retains prefix, uncited and recent results and the cited range and marker', () => {
  const id = 'a'.repeat(16);
  const read = {role: 'toolResult', toolName: 'read_note_lines', details: {path: 'Note.md', readRange: [1, 3]},
    content: [{type: 'text', text: 'x'.repeat(4000)}]};
  const messages = [{role: 'system', content: 'prefix'}, read, {...read, details: {path: 'Uncited.md', readRange: [1, 3]}}, read, read, read];
  const result = compactContext(messages, {evidence: new Map([[id, {path: 'Note.md', line: 3, quote: 'second'}]])}, 64);
  assert.equal(result[0], messages[0]);
  assert.equal(result[2], messages[2]);
  assert.equal(result.at(-1), messages.at(-1));
  assert.match(result[1].content[0].text, new RegExp(id));
  assert.match(result[1].content[0].text, /1–3/);
  assert.ok(result[1].content[0].text.length < 100);
});


test('settings probe both local protocols and one conversation continues from Anthropic to OpenAI', async (t) => {
  const endpoint = await localModel(t, (body, request) => {
    const probe = JSON.stringify(body.messages).includes('Connection check. Reply with OK.');
    if (request.url === '/v1/messages') {
      if (probe) return messageResponse({ type: 'text', text: 'OK' }, 'end_turn');
      const result = body.messages.at(-1).content?.find?.((b) => b.type === 'tool_result');
      if (!result) return messageResponse({ type: 'tool_use', name: 'cite_passage', id: 'cite',
        input: {path: 'Evidence.md', line: 3, quote: '计划尚未完成'} }, 'tool_use');
      const marker = JSON.stringify(result.content).match(/〔依据：[a-f0-9]{16}〕/u)?.[0];
      assert.ok(marker);
      return messageResponse({type: 'text', text: 'first-answer-sentinel' + marker}, 'end_turn');
    }
    assert.equal(request.url, '/v1/chat/completions');
    return completion(probe ? 'OK' : 'continued-answer-sentinel', [], probe ? '' : 'thinking fixture');
  });
  const { manager, call, config } = await sdkApplication(t, { dependencies: { piFetch: undefined } });
  const base = '/api/admin/provider-config';
  const current = await (await call(base)).json();
  const auth = { schemaVersion: 1, expectedRevision: current.revision, adminPassword: config.auth.password };
  const providers = ['anthropic-messages', 'openai-chat-completions'].map((protocol, i) => ({
    providerId: 'custom', apiBase: endpoint.url + '/v1', protocol, authMode: 'none', apiKeyAction: 'clear',
    models: [{ actualModel: 'local-' + i, enabled: true, default: i === 0 }],
  }));
  async function jsonRequest(route, method, payload) {
    const response = await call(route, { method, body: JSON.stringify(payload) });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  }
  const checked = await jsonRequest(base + '/validate', 'POST', {...auth, providers});
  assert.equal(checked.results.length, 2);
  assert.ok(checked.results.every((r) => r.ok));
  await jsonRequest(base, 'PUT', { ...auth, validationId: checked.validationId });
  const { models } = await (await call('/api/knowledge/status')).json();
  assert.equal(models.length, 2);
  let conversationId;
  for (const [i, model] of models.entries()) {
    const created = await jsonRequest('/api/knowledge/tasks', 'POST', {
      kind: 'qa', model: model.id, prompt: i ? 'continue' : 'first-question-sentinel', conversationId,
    });
    if (i) assert.equal(created.conversationId, conversationId);
    conversationId = created.conversationId;
    const reader = (await call('/api/knowledge/tasks/' + created.taskId + '/events')).body.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    try {
      while (!sse.includes('event: done')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        sse += decoder.decode(chunk.value, { stream: true });
      }
    } finally { await reader.cancel(); }
    for (const name of ['state', 'activity', 'session', 'text', 'done', ...(i ? ['thinking'] : [])]) assert.ok(sse.includes('event: ' + name), name);
    if (!i) {
      const task = manager.tasks.get(created.taskId);
      const textEvent = task.events.find((e) => e.type === 'text' && e.data.evidence);
      const passage = Object.values(textEvent.data.evidence)[0];
      assert.equal(passage.path, 'Evidence.md');
      assert.equal(passage.line, 3);
      assert.match(sse, /"evidence":\{"[0-9a-f]{16}"/u);
    }
    const done = manager.tasks.get(created.taskId).events.find((event) => event.type === 'done');
    assert.equal(done.data.usage.modelCalls, i ? 1 : 2);
    assert.equal(done.data.usage.reportedCalls, i ? 0 : 2);
    assert.equal(done.data.usage.inputTokens, i ? undefined : 200);
    assert.equal(done.data.usage.outputTokens, i ? undefined : 60);
    assert.equal(manager.tasks.get(created.taskId).status, 'completed');
    await Promise.all([...manager.running]);
  }
  const history = endpoint.requests.at(-1).messages;
  assert.ok(history.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('first-question-sentinel')));
  assert.ok(history.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('first-answer-sentinel')));
  const saved = JSON.parse(await fs.readFile(manager.conversationFile, 'utf8'));
  assert.deepEqual(saved.conversations[0].messages.filter((m) => m.role === 'assistant').map((m) => m.usage.reportedCalls), [2, 0]);
  assert.deepEqual(saved.conversations[0].messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('local connection probes have an enforced per-model timeout', async (t) => {
  let entered;
  const arrived = new Promise((resolve) => { entered = resolve; });
  const server = http.createServer(() => entered());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const probe = new PiModelRuntime({timeoutMs: 100}).validateAllEnabled({
    connections: [{...binding('http://127.0.0.1:' + server.address().port), id: 'test'}],
    models: [{actualModel: 'fixture', connectionId: 'test', id: 'model'}],
  });
  await Promise.all([arrived, assert.rejects(probe, { code: 'LLM_VALIDATION_FAILED' })]);
});

test('official model metadata maps high effort onto each protocol’s wire request', async () => {
  for (const [model, protocol, apiBase] of [
    ['gpt-5.4', 'openai-chat-completions', 'https://api.openai.com/v1'],
    ['claude-sonnet-4-6', 'anthropic-messages', 'https://api.anthropic.com'],
  ]) {
    const [entry] = piCatalog({ connections: [{id: 'official', providerId: 'custom', protocol, apiBase,
      authMode: protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer', apiKey: 'fixture-official-provider-test'}],
      models: [{id: model, connectionId: 'official', actualModel: model}] });
    assert.ok(entry.efforts.includes('high'));
    assert.ok(entry.modalities.includes('image'));
    let payload;
    const adapter = createPiModelAdapter(piBinding(entry), {effort: 'high', fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return protocol === 'anthropic-messages' ? messageResponse({type: 'text', text: 'ok'}, 'end_turn') : completion('ok');
    }});
    const result = await adapter.stream(adapter.model, {messages: [{role: 'user', content: 'test', timestamp: 0}]}).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(payload.model, model);
    if (protocol === 'anthropic-messages') {
      assert.equal(payload.output_config.effort, 'high');
      assert.equal(payload.thinking.type, 'adaptive');
    } else {
      assert.equal(payload.reasoning_effort, 'high');
      assert.ok(payload.max_completion_tokens > 0);
    }
  }
});
