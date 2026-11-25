import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

const critical = [
  '@earendil-works/pi-ai/dist/index.js',
  '@earendil-works/pi-agent-core/dist/index.js',
  '@modelcontextprotocol/sdk/package.json',
];
async function digest(file) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
async function filesBelow(root, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (!prefix && ['.bin', '.package-lock.json'].includes(entry.name)) continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected production dependency symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await filesBelow(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** Preserve published npm files, including dotfiles filtered by electron-builder. */
export async function copyPackagedDependencies({ stagedRoot, packagedRoot }) {
  const source = path.join(stagedRoot, 'node_modules');
  const destination = path.join(packagedRoot, 'node_modules');
  await fs.cp(source, destination, {
    recursive: true, verbatimSymlinks: true,
    filter: filename => !['.bin', '.package-lock.json'].includes(path.relative(source, filename)),
  });
  return verifyPackagedBackend({ stagedRoot, packagedRoot });
}

/** Verify the staged production tree before a distributable is created. */
export async function verifyPackagedBackend({ stagedRoot, packagedRoot }) {
  const source = path.join(stagedRoot, 'node_modules');
  const destination = path.join(packagedRoot, 'node_modules');
  for (const relative of critical) {
    const target = path.join(destination, relative);
    try {
      if (!(await fs.stat(target)).isFile()) throw new Error('not a file');
    } catch { throw new Error(`Packaged backend dependency missing: ${relative}`); }
  }
  const files = await filesBelow(source);
  if (!files.length) throw new Error('Staged backend dependency tree is empty');
  // Bound concurrent disk reads, across nested production packages.
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < files.length) {
      const relative = files[next++];
      const from = path.join(source, relative);
      const to = path.join(destination, relative);
      let installed;
      try { installed = await fs.stat(to); }
      catch { throw new Error(`Packaged backend dependency missing: ${relative}`); }
      const original = await fs.stat(from);
      if (!installed.isFile() || original.size !== installed.size || await digest(from) !== await digest(to)) {
        throw new Error(`Packaged backend dependency differs from staging: ${relative}`);
      }
    }
  }));
  return { filesVerified: files.length, criticalDependencies: critical };
}
