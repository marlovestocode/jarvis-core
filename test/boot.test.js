const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { runBoot, loginItem } = require('../src/core/boot');

test('runBoot: each stage reports ok/detail from its real result, failures do not stop the boot', async () => {
  const bus = createBus();
  const evs = [];
  bus.on('boot', e => evs.push(e));
  const res = await runBoot(bus, [
    { stage: 'core', run: async () => 'v0.2.0' },
    { stage: 'model', run: async () => { throw new Error('Ollama is not running'); } },
    { stage: 'bridge', run: async () => ({ ok: false, detail: 'port busy' }) },
  ]);
  assert.deepEqual(evs.map(e => [e.stage, e.ok, e.detail]), [
    ['core', true, 'v0.2.0'], ['model', false, 'Ollama is not running'], ['bridge', false, 'port busy'], ['done', false, '1 of 3 ready'],
  ]);
  assert.ok(evs.every(e => typeof e.ms === 'number'));
  assert.equal(res.ok, false);
});

test('loginItem: dev passes the app folder and --hidden; packaged passes --hidden only', () => {
  assert.deepEqual(loginItem({ enabled: true, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\app', packaged: false }),
    { openAtLogin: true, path: 'C:\\e\\electron.exe', args: ['C:\\app', '--hidden'] });
  assert.deepEqual(loginItem({ enabled: false, execPath: 'C:\\J.exe', appPath: 'x', packaged: true }),
    { openAtLogin: false, path: 'C:\\J.exe', args: ['--hidden'] });
});
