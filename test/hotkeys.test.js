const test = require('node:test');
const assert = require('node:assert/strict');
const { registerHotkeys } = require('../src/main/hotkeys');

function fakeShortcut(taken = []) {
  const registered = new Map();
  return {
    registered,
    register(accel, fn) {
      if (taken.includes(accel)) return false;
      registered.set(accel, fn);
      return true;
    },
    unregister(accel) { registered.delete(accel); },
  };
}

test('registerHotkeys reports accelerators whose register() returns false', () => {
  const gs = fakeShortcut(['Control+Space']);
  const res = registerHotkeys(gs, { 'Control+Space': () => {}, 'Control+Shift+Space': () => {} });
  assert.deepEqual(res.failed, ['Control+Space']);
  assert.deepEqual([...gs.registered.keys()], ['Control+Shift+Space']);
});

test('registerHotkeys reports accelerators whose register() throws (bad accelerator)', () => {
  const gs = fakeShortcut();
  gs.register = (a) => { throw new Error('bad ' + a); };
  assert.deepEqual(registerHotkeys(gs, { 'Nope+++': () => {} }).failed, ['Nope+++']);
});

test('registerHotkeys unregisters the previous set when called again', () => {
  const gs = fakeShortcut();
  const first = registerHotkeys(gs, { 'Control+Space': () => {} });
  assert.deepEqual(first.failed, []);
  const second = registerHotkeys(gs, { 'Control+Alt+J': () => {} }, first);
  assert.deepEqual(second.failed, []);
  assert.deepEqual([...gs.registered.keys()], ['Control+Alt+J']);
});
