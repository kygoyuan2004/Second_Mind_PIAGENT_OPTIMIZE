import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyPackagedDependencies, verifyPackagedBackend } from '../../scripts/verify-packaged-backend.mjs';

test('release guard rejects omitted dependencies and validates nested dependency bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secondmind-package-'));
  const stagedRoot = path.join(root, 'stage');
  const packagedRoot = path.join(root, 'package');
  const files = [
    '@earendil-works/pi-ai/dist/index.js',
    '@earendil-works/pi-agent-core/dist/index.js',
    '@modelcontextprotocol/sdk/package.json',
    'undici/lib/llhttp/.gitkeep',
    'outer/node_modules/inner/index.js',
  ];
  try {
    for (const filename of files) {
      const target = path.join(stagedRoot, 'node_modules', filename);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `fixture:${filename}`);
    }
    await fs.mkdir(packagedRoot);
    await assert.rejects(verifyPackagedBackend({ stagedRoot, packagedRoot }), /dependency missing/);
    await copyPackagedDependencies({ stagedRoot, packagedRoot });
    assert.equal((await verifyPackagedBackend({ stagedRoot, packagedRoot })).filesVerified, files.length);
    const nested = path.join(packagedRoot, 'node_modules', files.at(-1));
    await fs.writeFile(nested, 'damaged');
    await assert.rejects(verifyPackagedBackend({ stagedRoot, packagedRoot }), /differs from staging/);
    await fs.unlink(nested);
    await assert.rejects(verifyPackagedBackend({ stagedRoot, packagedRoot }), /dependency missing/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
