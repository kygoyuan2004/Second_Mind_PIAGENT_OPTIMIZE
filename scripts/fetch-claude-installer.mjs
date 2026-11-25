import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const packages = {
  win32: ['SecondMind-0.2.1-windows-x64-setup.exe', '64a92b872bdd4b2428028daca551c4d1fca59d06b215e3abafdc5a0416d85ca0'],
  linux: ['SecondMind-0.2.1-linux-amd64.deb', '7f078ea3df26bab5ac934639231e8e0c3eff3b31978a272e00e8a4b42a59135a'],
};
const [name, expected] = packages[process.platform] || [];
if (!name || !process.env.RUNNER_TEMP) throw new Error('Use a disposable Windows or Linux runner.');
const file = path.join(process.env.RUNNER_TEMP, name);
const response = await fetch('https://github.com/kygoyuan2004/Second-Mind/releases/download/v0.2.1/' + name);
if (!response.ok) throw new Error('Could not download Claude v0.2.1: ' + response.status);
await pipeline(response.body, createWriteStream(file));
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
if (hash.digest('hex') !== expected) { await fs.unlink(file); throw new Error('Original installer checksum mismatch'); }
console.log(file);
