'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoutineStore } = require('../src/core/routines/store');
const { createRoutineHandlers } = require('../src/main/routines-ipc');

const setup = () => {
  const store = createRoutineStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ri-')), 'r.json') });
  return { store, h: createRoutineHandlers({ routineStore: store }) };
};
const game = { name: 'Game Mode', steps: [{ tool: 'routine_close', args: { name: 'Discord' } }, { tool: 'set_system_volume', args: { percent: 40 } }] };

test('routines ipc: the three channels exist', () => {
  assert.deepEqual(Object.keys(setup().h).sort(), ['routines:list', 'routines:remove', 'routines:save']);
});

test('routines ipc: save, list (no run snapshots), remove', async () => {
  const { h, store } = setup();
  assert.deepEqual(await h['routines:save'](game), { ok: true });
  store.setLastRun('game mode', { at: 1, snapshot: { volume: 20 } });
  assert.deepEqual(await h['routines:list'](), [{ name: 'Game Mode', steps: game.steps }]);
  assert.equal(await h['routines:remove']('game mode'), true);
  assert.deepEqual(await h['routines:list'](), []);
});

test('routines ipc: a bad tool or a non-object payload is refused, never thrown', async () => {
  const { h } = setup();
  const bad = await h['routines:save']({ name: 'x', steps: [{ tool: 'power', args: {} }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /power/);
  for (const p of [null, 'x', 5, []]) assert.equal((await h['routines:save'](p)).ok, false);
  assert.equal(await h['routines:remove'](7), false);
});

test('routines ipc: a token smuggled into a saved step is dropped', async () => {
  const { h, store } = setup();
  await h['routines:save']({ name: 'x', steps: [{ tool: 'routine_close', args: { name: 'Discord', token: 'abc' } }] });
  assert.deepEqual(store.get('x').steps[0].args, { name: 'Discord' });
});
