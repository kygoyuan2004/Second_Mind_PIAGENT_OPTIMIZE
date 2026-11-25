import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnHidden, terminateProcessTree } from '../platform/process-tree.mjs';
import lock from '../src/scripts/media-model-lock.json' with { type: 'json' };

export const modelBytes = lock.files.reduce((bytes, file) => bytes + file.size, 0);
export const modelDirectory = root => path.join(root, 'models', 'faster-whisper-small');

export async function installedModel(stateRoot) {
  const directory = modelDirectory(stateRoot);
  try {
    const marker = JSON.parse(await fs.readFile(path.join(directory, '.complete.json'), 'utf8'));
    if (marker.revision !== lock.revision) return null;
    const files = await Promise.all(lock.files.map(file => fs.stat(path.join(directory, file.name))));
    return files.every((stat, i) => stat.isFile() && stat.size === lock.files[i].size) ? directory : null;
  } catch { return null; }
}

export async function readMediaModelStatus(stateRoot) {
  if (await installedModel(stateRoot)) return { model: 'small', state: 'ready', downloadedBytes: modelBytes, totalBytes: modelBytes };
  try {
    const status = JSON.parse(await fs.readFile(path.join(stateRoot, 'models', 'status.json'), 'utf8'));
    const allowed = new Set(['not-downloaded', 'downloading', 'error']);
    if (!allowed.has(status.state)) throw new Error('Invalid media status');
    if (status.state === 'downloading' && status.updatedAt && Date.now() / 1000 - status.updatedAt > 120) {
      return { ...status, model: 'small', state: 'error', message: '语音模型下载已中断，请重试。' };
    }
    return { model: 'small', ...status };
  } catch { return { model: 'small', state: 'not-downloaded', downloadedBytes: 0, totalBytes: modelBytes }; }
}

/** Explicit preparation/retry; calling status never downloads a model. */
export function prepareMediaModel({ resources, stateRoot, signal }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = async () => {
      if (finished) return;
      finished = true;
      const message = signal?.aborted ? '语音模型下载已取消，可稍后重试。' : '语音模型下载失败，请检查网络和运行组件后重试。';
      const statusPath = path.join(stateRoot, 'models', 'status.json');
      const temporary = `${statusPath}.${process.pid}.tmp`;
      try {
        await fs.mkdir(path.dirname(statusPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, JSON.stringify({ model: 'small', state: 'error', message, updatedAt: Date.now() / 1000 }), { mode: 0o600 });
        await fs.rename(temporary, statusPath);
      } catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
      reject(new Error(message));
    };
    const env = {
      KNOWLEDGE_MEDIA_RUNTIME: '1', KNOWLEDGE_SPEECH_MODEL_DIR: modelDirectory(stateRoot),
      KNOWLEDGE_MEDIA_MODEL_STATUS: path.join(stateRoot, 'models', 'status.json'),
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    };
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
      'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const child = spawnHidden(resources.python, ['-B', '-X', 'utf8', path.join(resources.appRoot, 'src', 'scripts', 'media_model.py')], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
    });
    const abort = () => { void terminateProcessTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on('data', () => {});
    child.once('error', () => { signal?.removeEventListener('abort', abort); void fail(); });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (finished) return;
      if (code === 0) { finished = true; resolve(readMediaModelStatus(stateRoot)); }
      else void fail();
    });
  });
}
