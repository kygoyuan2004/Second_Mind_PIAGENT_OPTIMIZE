import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { completion, localModel } from './loopback-chat.mjs';

export async function verifyPackagedQuestion(t, page, knowledgeBaseId) {
  const key = 'fixture-' + randomUUID();
  const path = '测试笔记.md';
  const quote = '这是关键词检索与文件路径测试。';
  let turns = 0;
  const upstream = await localModel(t, (body, request) => {
    assert.equal(request.headers.authorization, 'Bearer ' + key);
    if (JSON.stringify(body.messages).includes('Connection check. Reply with OK.')) return completion('OK');
    turns++;
    const last = body.messages.at(-1);
    if (turns === 1) return completion('', [['read_note_lines', { path, startLine: 2, limit: 2 }]]);
    if (turns === 2) {
      assert.ok(JSON.parse(last.content).text.includes('3│ ' + quote));
      return completion('', [['cite_passage', { path, line: 3, quote }]]);
    }
    assert.equal(turns, 3);
    const citation = last.content.match(/〔依据：[a-f0-9]{16}〕/u)?.[0];
    assert.ok(citation);
    return completion(quote + citation);
  });
  const events = await page.evaluate(async ({ endpoint, key, knowledgeBaseId }) => {
    const query = '?knowledgeBaseId=' + encodeURIComponent(knowledgeBaseId);
    async function call(url, method = 'GET', body) {
      const response = await fetch(url + query, { method, headers: { 'content-type': 'application/json',
        'x-vaultmind-request': '1' }, body: body && JSON.stringify(body) });
      if (!response.ok) throw new Error(method + ' ' + url + ' ' + response.status + ' ' + await response.text());
      return response.json();
    }
    const settings = '/api/admin/provider-config';
    const original = await call(settings);
    const revision = { schemaVersion: 1, expectedRevision: original.revision };
    const provider = { providerId: 'custom', protocol: 'openai-chat-completions', apiBase: endpoint + '/v1',
      authMode: 'bearer', apiKeyAction: 'replace', apiKey: key,
      models: [{ actualModel: 'desktop-fixture', enabled: true, default: true }] };
    const checked = await call(settings + '/validate', 'POST', { ...revision, providers: [provider] });
    if (!checked.results.every(result => result.ok)) throw new Error('Packaged provider validation failed');
    await call(settings, 'PUT', { ...revision, validationId: checked.validationId });
    const { models } = await call('/api/knowledge/status');
    const task = await call('/api/knowledge/tasks', 'POST', { kind: 'qa', model: models[0].id, prompt: '逐行核查测试笔记，引用第三行。' });
    const response = await fetch('/api/knowledge/tasks/' + task.taskId + '/events' + query, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Packaged task stream unavailable');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let stream = '';
    try {
      while (!/event: done[^\n]*\n(?:data: [^\n]*\n)+\n/u.test(stream)) {
        const next = await reader.read();
        if (next.done) break;
        stream += next.value.replaceAll('\r', '');
      }
    } finally { await reader.cancel(); }
    return stream.split('\n\n').filter(block => block.startsWith('event:') || block.includes('\nevent:'))
      .map(block => ({ type: block.match(/(?:^|\n)event: (.+)/u)?.[1],
        data: JSON.parse(block.match(/(?:^|\n)data: (.+)/u)[1]) }));
  }, { endpoint: upstream.url, key, knowledgeBaseId });
  assert.equal(turns, 3);
  const done = events.find(event => event.type === 'done');
  assert.equal(done?.data.usage.modelCalls, 3);
  const evidence = events.flatMap(event => Object.values(event.data.evidence || {}));
  assert.ok(evidence.some(item => item.path === path && item.line === 3 && item.quote === quote));
}
