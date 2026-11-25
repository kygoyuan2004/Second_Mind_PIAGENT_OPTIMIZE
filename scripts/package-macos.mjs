import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, Platform, build } from 'electron-builder';
import { copyPackagedDependencies } from './verify-packaged-backend.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const arch = process.arch;
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
  throw new Error('Build on a native Apple Silicon or Intel Mac.');
}
const archName = arch === 'arm64' ? 'arm64' : 'x86_64';
if (execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim() !== archName) {
  throw new Error('Node and the native macOS runner must have the same architecture.');
}
const stage = path.join(root, 'build', 'macos', arch);
const backend = path.join(stage, 'backend');
const output = path.join(root, 'dist', 'macos', arch);
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
const lock = JSON.parse(await fs.readFile(path.join(root, 'scripts/macos/runtime-lock.json')));
const python = process.env.BUILD_PYTHON || 'python3';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });

run(python, ['scripts/macos/prepare.py']);
await fs.rm(backend, { force: true, recursive: true });
await fs.mkdir(backend, { recursive: true });
for (const entry of ['src', 'public', 'desktop', 'platform', 'package.json', 'package-lock.json', 'LICENSE']) {
  await fs.cp(path.join(root, entry), path.join(backend, entry), {
    recursive: true, filter: name => !name.endsWith('__pycache__') && !name.endsWith('.pyc'),
  });
}
if (!process.env.npm_execpath) throw new Error('Run npm run desktop:build:mac.');
run(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'], backend);
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await build({
  projectDir: root, publish: 'never', targets: Platform.MAC.createTarget(['dmg'], arch === 'arm64' ? Arch.arm64 : Arch.x64),
  config: {
    extends: null, appId: 'io.secondmind.pi.desktop', productName: pkg.productName,
    directories: { output }, asar: true, npmRebuild: false,
    artifactName: 'SecondMindPi-${version}-macos-${arch}.${ext}',
    files: ['desktop/**/*', 'platform/*.mjs', 'package.json', '!node_modules/**'],
    mac: {
      identity: null, notarize: false, hardenedRuntime: false, minimumSystemVersion: lock.minimumSystemVersion,
      category: 'public.app-category.productivity',
      extendInfo: { NSMicrophoneUsageDescription: 'Record audio when you choose to dictate a Second Mind Pi note.' },
    },
    dmg: { sign: false, writeUpdateInfo: false },
    extraResources: [
      { from: backend, to: 'backend', filter: ['**/*', '!node_modules/**', '!node_modules'] },
      { from: 'docs/macos-desktop.md', to: 'macOS-README.md' },
    ],
    afterPack: async ({ appOutDir }) => {
      const app = path.join(appOutDir, pkg.productName + '.app');
      const resources = path.join(app, 'Contents/Resources');
      run('/usr/bin/ditto', [path.join(stage, 'runtime'), path.join(resources, 'runtime')]);
      await copyPackagedDependencies({ stagedRoot: backend, packagedRoot: path.join(resources, 'backend') });
      run(python, [path.join(root, 'scripts/macos/sign.py'), app]);
    },
  },
});
const filename = 'SecondMindPi-' + pkg.version + '-macos-' + arch + '.dmg';
const hash = createHash('sha256');
for await (const data of createReadStream(path.join(output, filename))) hash.update(data);
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), hash.digest('hex') + '  ' + filename + '\n');
