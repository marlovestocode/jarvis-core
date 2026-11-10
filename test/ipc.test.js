const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ busy = false, speaking = false, active = false } = {}) {
  const handlers = new Map(), calls = [];
  const module = { exports: {} };
  const electron = { ipcMain: { removeHandler() {}, handle: (name, fn) => handlers.set(name, fn) } };
  const nativeRequire = require;
  const filename = path.join(__dirname, '../src/main/ipc.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: id => id === 'electron' ? electron : nativeRequire(path.resolve(path.dirname(filename), id)) });
  const ctx = {
    orchestrator: { busy, stop: () => calls.push('model stop') }, sessions: {},
    windows: { hideChat: () => calls.push('hide') },
    voice: { speaking, active, cancel: () => calls.push('voice cancel') },
  };
  module.exports.registerIpc(ctx);
  return { escape: () => handlers.get('ai:escape')({}), calls };
}

test('Escape stops streaming model and speech together', () => {
  const h = setup({ busy: true, speaking: true, active: true });
  assert.equal(h.escape(), 'stopped');
  assert.deepEqual(h.calls, ['model stop', 'voice cancel']);
});

test('Escape cancels voice after generation, otherwise hides chat', () => {
  const voice = setup({ speaking: true, active: true });
  assert.equal(voice.escape(), 'cancelled');
  assert.deepEqual(voice.calls, ['voice cancel']);
  const idle = setup();
  assert.equal(idle.escape(), 'hidden');
  assert.deepEqual(idle.calls, ['hide']);
});
