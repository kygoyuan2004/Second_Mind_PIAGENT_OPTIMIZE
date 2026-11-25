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
  const app = await _electron.launch({ executablePath: exe, env, args: process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [] });
  running.push(app);
  await app.firstWindow();
  return app.evaluate(({ app }) => ({ directory: app.getPath('userData'), pid: process.pid }));
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
    const piMarker = path.join(pi.directory, sentinel);
    await fs.writeFile(oldMarker, 'claude-0.2.1');
    await fs.writeFile(piMarker, 'pi-0.3.0');
    assert.equal(await fs.readFile(oldMarker, 'utf8'), 'claude-0.2.1');
    assert.equal(await fs.readFile(piMarker, 'utf8'), 'pi-0.3.0');
  } else {
    assert.equal(await fs.readFile(oldMarker, 'utf8'), 'claude-0.2.1');
  }
} finally {
  for (const app of running.reverse()) await app.close();
}
