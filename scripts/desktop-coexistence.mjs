import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';

const [mode, work, claudeExe, piExe] = process.argv.slice(2);
if (!['pair', 'survivor'].includes(mode) || !work || !claudeExe) throw new Error('Expected pair|survivor, fixture directory and installed executable paths.');
await fs.mkdir(work, { recursive: true });
const env = { ...process.env, LOCALAPPDATA: path.join(work, 'local'), XDG_CONFIG_HOME: path.join(work, 'config') };
delete env.ELECTRON_RUN_AS_NODE;
const running = [];
async function launch(exe) {
  console.log('Starting ' + path.basename(exe));
  const app = await _electron.launch({ executablePath: exe, timeout: 30_000, env, args: process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [] });
  running.push(app);
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.secondMindDesktop), undefined, { timeout: 30_000 });
  const info = await app.evaluate(({ app }) => ({ directory: app.getPath('userData'), pid: process.pid }));
  console.log(path.basename(exe) + ' opened with profile ' + path.basename(info.directory));
  return { ...info, page };
}
async function savedNames(page) {
  return page.evaluate(async () => (await window.secondMindDesktop.getState()).preferences.connections.map(record => record.name));
}
async function saveFixture(page, name) {
  await page.evaluate(name => window.secondMindDesktop.saveConnection({
    name, url: 'https://editions.example.test', trustedHttp: false,
  }), name);
}
const sentinel = 'coexistence-check.txt';
try {
  const original = await launch(claudeExe);
  assert.equal(path.basename(original.directory), 'SecondMind');
  const oldMarker = path.join(original.directory, sentinel);
  if (mode === 'pair') {
    const pi = await launch(piExe);
    assert.notEqual(original.pid, pi.pid);
    assert.equal(path.basename(pi.directory), 'SecondMindPi');
    assert.notEqual(original.directory, pi.directory);
    await saveFixture(original.page, 'Claude fixture');
    await saveFixture(pi.page, 'Pi fixture');
    assert.deepEqual(await savedNames(original.page), ['Claude fixture']);
    assert.deepEqual(await savedNames(pi.page), ['Pi fixture']);
    const piMarker = path.join(pi.directory, sentinel);
    await fs.writeFile(oldMarker, 'claude-0.2.1');
    await fs.writeFile(piMarker, 'pi-0.3.0');
    assert.equal(await fs.readFile(oldMarker, 'utf8'), 'claude-0.2.1');
    assert.equal(await fs.readFile(piMarker, 'utf8'), 'pi-0.3.0');
  } else {
    assert.deepEqual(await savedNames(original.page), ['Claude fixture']);
    assert.equal(await fs.readFile(oldMarker, 'utf8'), 'claude-0.2.1');
  }
} finally {
  for (const app of running.reverse()) await app.close();
}
