import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createConfig } from '../src/config.mjs';
import { startApplication } from '../src/bootstrap.mjs';
import { PiModelRuntime } from '../src/pi-runtime.mjs';
import { KnowledgeStore } from '../src/original/knowledge-store.mjs';
import { VaultPathPolicy } from '../src/path-policy.mjs';
import { temporaryProject } from './helpers.mjs';

import { messageResponse, waitFor } from './sdk-test-helpers.mjs';

test('denied enumeration under a hidden directory isolates SDK reads while visible access errors remain actionable', async (t) => {
  const project = await temporaryProject('sdk-restricted-vault-');
  t.after(() => project.cleanup());
  const hidden = path.join(project.vaultPath, '.support-cache', 'private');
  const visible = path.join(project.vaultPath, 'Notes');
  await fs.mkdir(hidden, { recursive: true });
  await fs.mkdir(visible);
  await fs.writeFile(path.join(visible, 'Note.md'), 'Public note');
  let denied = hidden;
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if (dir === denied) throw Object.assign(new Error('Directory access denied'), { code: 'EPERM' });
    return readdir(dir, ...args);
  });
  const policy = await new VaultPathPolicy(project.vaultPath).initialize();
  const walk = () => Array.fromAsync(policy.walk());
  assert.deepEqual(await walk(), ['Notes/Note.md']);
  for (denied of [visible, project.vaultPath]) await assert.rejects(walk, { code: 'EPERM' });

});

test('a successful SDK connection probe releases its working directory before settings are saved', { timeout: 60_000 }, async (t) => {
  const project = await temporaryProject('sdk-probe-');
  t.after(() => project.cleanup());
  const stateDir = path.join(project.dataDir, 'sdk-validation');
  const runtime = new PiModelRuntime({
    stateDir,
    fetch: async () => messageResponse({ type: 'text', text: 'OK' }, 'end_turn'),
  });
  const result = await runtime.validateAllEnabled({
    connections: [{ id: 'fixture', providerId: 'deepseek', protocol: 'anthropic-messages',
      authMode: 'bearer', apiBase: 'https://api.deepseek.com/anthropic', apiKey: 'synthetic-sdk-probe' }],
    models: [{ id: 'probe', actualModel: 'deepseek-flash', connectionId: 'fixture' }],
  });
  assert.equal(result.checked, 1);
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});

test('real Agent SDK reads a Vault containing a linked tool cache, streams citations and resumes its session', { timeout: 60_000 }, async (t) => {
  const project = await temporaryProject('second-mind-sdk-');
  let app;
  t.after(async () => {
    if (app) {
      await app.knowledgeBaseHub.close();
      app.server.closeAllConnections?.();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });
  await fs.mkdir(path.join(project.vaultPath, '.obsidian'));
  await fs.writeFile(path.join(project.vaultPath, 'Evidence.md'), '# Evidence\n\n公开演示资料：验收标记是 sdkpublicmarker，计划尚未完成。\n');
  const cache = path.join(project.vaultPath, '.cache', 'codex-runtimes', 'demo', 'node_modules');
  await fs.mkdir(cache, { recursive: true });
  const cachedModule = path.join(cache, 'fixture-module');
  await fs.symlink(cache, cachedModule, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(cache, 'cache-marker.txt'), 'unrelated build cache');
  const requests = [];
  const credential = 'synthetic-sdk-provider-credential';
  let toolSequence = 0;
  const piFetch = async (url, init) => {
    assert.equal(String(url), 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages');
    assert.equal(init.headers['x-api-key'], credential);
    const body = JSON.parse(init.body);
    assert.ok(!init.body.includes(credential));
    requests.push(body);
    if (toolSequence++ === 0) return messageResponse({ type: 'tool_use', id: 'read_fixture', name: 'read_note_lines', input: { path: 'Evidence.md' } }, 'tool_use');
    if (toolSequence === 2) return messageResponse({ type: 'tool_use', id: 'search_fixture', name: 'knowledge_search', input: { query: 'sdkpublicmarker' } }, 'tool_use');
    return messageResponse({ type: 'text', text: '验收标记是 sdkpublicmarker；计划尚未完成。〔来源：Evidence.md#Evidence〕' }, 'end_turn');
  };
  const config = createConfig({ ...project.config, host: '127.0.0.1', port: 0,
    publicDir: path.resolve('public'), retrieval: { watch: false },
    auth: { username: 'admin', password: 'synthetic admin password', sessionSecret: 'synthetic-session-secret-with-at-least-32-characters' },
    llm: { provider: 'anthropic', protocol: 'anthropic-messages', authMode: 'x-api-key',
      apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic', apiKey: credential, model: 'qwen3.8-max' },
    embedding: { provider: 'disabled' }, webSearch: { enabled: false },
  });
  app = await startApplication({ config, dependencies: { piFetch } });
  await app.ready;
  const base = `http://127.0.0.1:${app.port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'synthetic admin password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (url, opts = {}) => fetch(`${base}${url}`, { ...opts, headers: {
    cookie, origin: base, 'content-type': 'application/json', 'x-vaultmind-request': '1', ...opts.headers } });
  const status = await (await call('/api/knowledge/status?knowledgeBaseId=default')).json();
  assert.equal(status.executor, 'pi-agent-sdk');
  const create = await call('/api/knowledge/tasks?knowledgeBaseId=default', { method: 'POST', body: JSON.stringify({
    kind: 'qa', model: status.models[0].id, effort: 'xhigh', prompt: '检索“sdkpublicmarker”，读取原文后说明计划状态并引用来源。',
  }) });
  assert.equal(create.status, 201, JSON.stringify(await create.clone().json()));
  const created = await create.json();
  const manager = app.knowledgeBaseHub.resolve('default').manager;
  const finished = await waitFor(() => {
    const task = manager.tasks.get(created.taskId);
    return ['completed', 'failed', 'cancelled', 'timed_out'].includes(task?.status) && task;
  });
  assert.equal(finished.status, 'completed', JSON.stringify(finished.events.filter((e) => ['task_error', 'warning'].includes(e.type))));
  assert.match(finished.assistantText, /〔来源：Evidence.md#Evidence〕/);
  assert.ok(finished.events.some((e) => e.type === 'text'));
  assert.ok(finished.events.some((e) => e.data.toolName === 'read_note_lines'));
  assert.ok(finished.events.some((e) => e.data.toolName === 'knowledge_search'));
  const toolResults = requests.flatMap((r) => r.messages).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_result');
  assert.ok(toolResults.some((b) => b.tool_use_id === 'read_fixture' && JSON.stringify(b.content).includes('计划尚未完成')));
  assert.ok(toolResults.some((b) => b.tool_use_id === 'search_fixture' && !b.is_error));
  assert.equal(JSON.stringify(requests).includes('unrelated build cache'), false);
  assert.equal((await fs.lstat(cachedModule)).isSymbolicLink(), true);
  assert.equal(requests[0].output_config?.effort, 'xhigh');
  assert.ok(requests[0].max_tokens > 0);
  assert.equal(finished.root, project.vaultPath);
  await waitFor(() => !manager.taskRegistry.active?.has?.(finished.userId));
  const next = await call('/api/knowledge/tasks?knowledgeBaseId=default', { method: 'POST', body: JSON.stringify({
    kind: 'qa', model: status.models[0].id, effort: 'xhigh', conversationId: created.conversationId,
    prompt: '继续：再确认上一轮提到的计划状态。',
  }) });
  assert.equal(next.status, 201, JSON.stringify(await next.clone().json()));
  const nextId = (await next.json()).taskId;
  await waitFor(() => manager.tasks.get(nextId)?.status === 'completed');
  assert.ok(requests.at(-1).messages.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('计划尚未完成')));
  assert.ok(!(await fs.readFile(manager.conversationFile, 'utf8')).includes(credential));
});
