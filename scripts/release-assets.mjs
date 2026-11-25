import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [artifacts, destination, tag] = process.argv.slice(2);
const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version;
assert.equal(tag, 'v' + version);
const prefix = 'SecondMindPi-' + version;
const required = {
  'windows-x64': [prefix + '-windows-x64-setup.exe'],
  'linux-x64': [prefix + '-linux-amd64.deb', prefix + '-linux-x86_64.AppImage'],
  'macos-arm64': [prefix + '-macos-arm64.dmg'],
  'macos-x64': [prefix + '-macos-x64.dmg'],
};
await fs.mkdir(destination, { recursive: true });
const manifest = [];
for (const [platform, names] of Object.entries(required)) {
  const root = path.join(artifacts, 'SecondMindPi-' + platform);
  const declared = (await fs.readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64}) [ *]([^/\\]+)$/u.exec(line);
    if (!match) throw new Error('Invalid SHA256SUMS entry in ' + platform);
    return [match[2], match[1]];
  });
  assert.deepEqual(declared.map(entry => entry[0]).sort(), names.sort());
  for (const [file, expected] of declared) {
    const source = path.join(root, file);
    assert.ok((await fs.stat(source)).size > 0);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    assert.equal(hash.digest('hex'), expected, file);
    await fs.copyFile(source, path.join(destination, file));
    manifest.push(expected + '  ' + file);
  }
}
await fs.writeFile(path.join(destination, 'SHA256SUMS.txt'), manifest.sort().join('\n') + '\n');
