import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SpeechModel } from '../src/speech-model.mjs';
import lock from '../src/scripts/media-model-lock.json' with { type: 'json' };
import { sdkApplication, waitFor } from './sdk-test-helpers.mjs';

// Drive the real process manager and HTTP routes without downloading weights
// or requesting a real microphone. Sparse files exercise the pinned sizes.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-button-'));
  const python = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const model = new SpeechModel({ stateRoot: root, python });
  t.after(async () => { await model.close(); await fs.rm(root, { recursive: true, force: true }); });
  model.resources.appRoot = root;
  const scripts = path.join(root, 'src', 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(path.join(scripts, 'media_model.py'), `import json, os, pathlib, sys, time
status = pathlib.Path(os.environ['KNOWLEDGE_MEDIA_MODEL_STATUS'])
root = status.parent.parent
status.parent.mkdir(exist_ok=True)
with (root / 'starts').open('a') as output: output.write('1')
progress = status.with_suffix('.tmp')
progress.write_text(json.dumps(dict(state='downloading', downloadedBytes=243106186, totalBytes=486212372)))
os.replace(progress, status)
while not (root / 'finish').exists(): time.sleep(0.02)
sys.exit(0 if (root / 'finish').read_text() == 'ok' else 1)
`);
  const instance = await sdkApplication(t, { dependencies: { speechModel: model } });
  async function install() {
    const directory = model.environment.KNOWLEDGE_SPEECH_MODEL_DIR;
    await fs.mkdir(directory, { recursive: true });
    for (const file of lock.files) {
      const handle = await fs.open(path.join(directory, file.name), 'w');
      try { await handle.truncate(file.size); } finally { await handle.close(); }
    }
    await fs.writeFile(path.join(directory, '.complete.json'), JSON.stringify({ revision: lock.revision }));
    await fs.writeFile(path.join(root, 'finish'), 'ok');
  }
  return { ...instance, model, root, install };
}

test('the authenticated speech model API gates the microphone, shares one download, retries and repairs stale state', async t => {
  const { base, call, cookie, model, root, install } = await fixture(t);
  const endpoint = '/api/knowledge/speech-model';
  assert.equal((await fetch(base + endpoint)).status, 401);
  assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { cookie } })).status, 403);
  const initial = await (await call('/api/knowledge/status')).json();
  assert.equal(initial.speechTranscription.model.state, 'not-downloaded');
  assert.equal(initial.speechTranscription.available, true);
  const blocked = await call('/api/knowledge/transcribe', { method: 'POST', body: JSON.stringify({ type: 'audio/wav', data: 'YQ==' }) });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'SPEECH_MODEL_NOT_READY');
  assert.equal(await fs.stat(path.join(root, 'starts')).catch(() => null), null);
  const results = await Promise.all([call(endpoint, { method: 'POST' }), call(endpoint, { method: 'POST' }), model.start()]);
  assert.deepEqual(results.slice(0, 2).map(r => r.status), [202, 202]);
  await waitFor(async () => (await (await call(endpoint)).json()).model.downloadedBytes === 243106186);
  assert.equal(await fs.readFile(path.join(root, 'starts'), 'utf8'), '1');
  await fs.writeFile(path.join(root, 'finish'), 'fail');
  await model.operation;
  assert.equal((await (await call(endpoint)).json()).model.state, 'error');
  await fs.rm(path.join(root, 'finish'));
  await call(endpoint, { method: 'POST' });
  await waitFor(async () => (await fs.readFile(path.join(root, 'starts'), 'utf8')) === '11');
  await install();
  await model.operation;
  assert.equal((await (await call(endpoint, { method: 'POST' })).json()).model.state, 'ready');
  assert.equal(await fs.readFile(path.join(root, 'starts'), 'utf8'), '11');
  const restarted = new SpeechModel({ stateRoot: root, python: model.resources.python });
  assert.equal((await restarted.status()).state, 'ready');
  await fs.rm(path.join(model.environment.KNOWLEDGE_SPEECH_MODEL_DIR, 'model.bin'));
  await fs.writeFile(model.environment.KNOWLEDGE_MEDIA_MODEL_STATUS, JSON.stringify({ state: 'ready' }));
  assert.equal((await restarted.status()).state, 'not-downloaded');
});

test('the composer keeps typing available and opens the microphone only on a separate click after download', async t => {
  const chrome = process.env.SECOND_MIND_TEST_CHROME || '/usr/bin/google-chrome';
  if (!await fs.stat(chrome).catch(() => null)) return t.skip('Browser binary unavailable');
  const { chromium } = await import('playwright');
  const { base, cookie, root, install } = await fixture(t);
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.context().addCookies([{ url: base, name: cookie.slice(0, cookie.indexOf('=')), value: cookie.slice(cookie.indexOf('=') + 1) }]);
  await page.addInitScript(() => {
    window.micRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.micRequests++; throw new DOMException('Test microphone', 'NotAllowedError'); };
  });
  await page.goto(base + '/knowledge.html');
  const button = page.locator('#knowledge-mic');
  const prompt = page.locator('#knowledge-prompt');
  const label = text => button.filter({ hasText: text }).waitFor({ timeout: 8000 });
  await label('下载语音模型（约 486 MB）');
  await button.click();
  await label('50%');
  assert.equal(await button.isDisabled(), true);
  await prompt.fill('下载期间保留我的问题');
  assert.equal(await page.locator('#knowledge-send').isEnabled(), true);
  assert.equal(await page.evaluate(() => window.micRequests), 0);
  await fs.writeFile(path.join(root, 'finish'), 'fail');
  await label('重试下载');
  await fs.rm(path.join(root, 'finish'));
  await button.click();
  await label('50%');
  await install();
  await label('开始口述');
  assert.equal(await prompt.inputValue(), '下载期间保留我的问题');
  assert.equal(await page.evaluate(() => window.micRequests), 0);
  await page.reload();
  await label('开始口述');
  await button.click();
  await page.waitForFunction(() => window.micRequests === 1);
  assert.equal(await fs.readFile(path.join(root, 'starts'), 'utf8'), '11');
});
