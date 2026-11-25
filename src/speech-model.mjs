import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lock from './scripts/media-model-lock.json' with { type: 'json' };
import { installedModel, modelBytes, modelDirectory, prepareMediaModel, readMediaModelStatus } from '../desktop/media-model.mjs';

// Docker v0.3.0 kept faster-whisper Hub snapshots in each workspace. A
// snapshot may link into its repository's blobs. Verify the pinned bytes.
async function verifiedSnapshot(repository, revision, checks) {
  const snapshot = path.join(repository, 'snapshots', revision);
  try {
    const base = await fs.realpath(repository);
    const files = await Promise.all(lock.files.map(async file => {
      const location = await fs.realpath(path.join(snapshot, file.name));
      const stat = await fs.stat(location);
      if (!location.startsWith(base + path.sep) || !stat.isFile() || stat.size !== file.size) return null;
      return { location, stamp: [location, stat.ino, stat.mtimeMs, stat.ctimeMs], expected: file.sha256 };
    }));
    if (files.some(file => !file)) return null;
    const key = JSON.stringify(files.map(file => file.stamp));
    if (checks.get(snapshot)?.key !== key) {
      const verified = (async () => {
        for (const file of files) {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(file.location)) hash.update(chunk);
          if (hash.digest('hex') !== file.expected) return false;
        }
        return true;
      })();
      checks.set(snapshot, { key, verified });
    }
    return await checks.get(snapshot).verified ? snapshot : null;
  } catch { return null; }
}

export class SpeechModel {
  constructor({ stateRoot, python, legacyDocker = false }) {
    this.stateRoot = stateRoot;
    this.resources = { appRoot: fileURLToPath(new URL('../', import.meta.url)), python };
    this.environment = {
      KNOWLEDGE_MEDIA_RUNTIME: '1', KNOWLEDGE_SPEECH_MODEL_DIR: modelDirectory(stateRoot),
      KNOWLEDGE_MEDIA_MODEL_STATUS: path.join(stateRoot, 'models', 'status.json'),
    };
    this.legacyDocker = legacyDocker;
    this.repositories = new Set();
    this.checks = new Map();
    this.operation = null;
    this.closed = false;
  }

  addWorkspace(dataDir) {
    if (!this.legacyDocker) return;
    const homes = [
      path.join(dataDir, 'speech', 'home', '.cache', 'huggingface'),
      path.join(dataDir, 'video', 'home', 'cache', 'huggingface'),
    ];
    if (process.env.HF_HOME) homes.push(process.env.HF_HOME);
    for (const home of homes) this.repositories.add(path.join(home, 'hub', 'models--Systran--faster-whisper-small'));
  }

  async legacyDirectory() {
    for (const repository of this.repositories) {
      const current = await fs.readFile(path.join(repository, 'refs', 'main'), 'utf8').catch(() => '');
      for (const revision of new Set([lock.revision, current.trim()])) {
        if (!/^[0-9a-f]{40}$/.test(revision)) continue;
        const directory = await verifiedSnapshot(repository, revision, this.checks);
        if (directory) return directory;
      }
    }
    return null;
  }

  async directory() {
    return await installedModel(this.stateRoot) || this.legacyDirectory();
  }

  async status() {
    const status = await readMediaModelStatus(this.stateRoot);
    if (status.state === 'ready') return status;
    if (await this.legacyDirectory()) return { model: 'small', state: 'ready', downloadedBytes: modelBytes, totalBytes: modelBytes };
    if (this.operation && status.state !== 'downloading') {
      return { model: 'small', state: 'downloading', downloadedBytes: 0, totalBytes: modelBytes };
    }
    if (this.failure && status.state === 'not-downloaded') return { ...status, state: 'error', message: this.failure };
    return status;
  }

  async start() {
    const status = await this.status();
    if (this.closed) throw new Error('Speech model manager is closing.');
    if (status.state === 'ready') return status;
    if (!this.operation) {
      this.controller = new AbortController();
      this.failure = '';
      this.operation = prepareMediaModel({ resources: this.resources, stateRoot: this.stateRoot, signal: this.controller.signal })
        .catch(error => { this.failure = error.message; }).finally(() => { this.operation = null; });
    }
    return { model: 'small', state: 'downloading', downloadedBytes: status.downloadedBytes || 0, totalBytes: modelBytes };
  }

  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.operation;
  }
}

export function configuredSpeechModel(dataDir) {
  const desktop = process.env.KNOWLEDGE_MEDIA_RUNTIME === '1' && process.env.KNOWLEDGE_MEDIA_MODEL_STATUS;
  const docker = process.env.SECOND_MIND_DOCKER_SPEECH === '1';
  if ((!desktop && !docker) || process.env.KNOWLEDGE_ASR_MODEL_DIR || process.env.KNOWLEDGE_SPEECH_SCRIPT ||
      (process.env.KNOWLEDGE_SPEECH_MODEL && process.env.KNOWLEDGE_SPEECH_MODEL !== 'small')) return null;
  return new SpeechModel({
    stateRoot: desktop ? path.dirname(path.dirname(process.env.KNOWLEDGE_MEDIA_MODEL_STATUS)) : dataDir,
    python: process.env.KNOWLEDGE_SPEECH_PYTHON || '/opt/media/bin/python',
    legacyDocker: docker && !desktop,
  });
}
