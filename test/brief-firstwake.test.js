'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createFirstWake } = require('../src/core/brief/firstwake');

function setup({ brief = {}, now = new Date(2026, 10, 16, 8, 0), quiet = false, run } = {}) {
  const bus = createBus();
  const calls = [];
  const state = { brief: { auto: true, onFirstWake: true, lastDate: '', ...brief } };
  const fw = createFirstWake({
    bus, getConfig: () => state,
    saveBriefDate: d => { calls.push(['save', d]); state.brief.lastDate = d; },
    run: run || (async () => { calls.push(['run']); }),
    now: () => now, isQuiet: () => quiet,
  });
  return { bus, calls, fw, state };
}
const tick = () => new Promise(r => setImmediate(r));

test('first wake: two wakes the same day run once, date saved before run', async () => {
  const { bus, calls } = setup();
  bus.emit('wake'); bus.emit('wake'); await tick();
  assert.deepEqual(calls, [['save', '2026-11-16'], ['run']]);
});

test('first wake: a new day runs again', async () => {
  const { bus, calls } = setup({ brief: { lastDate: '2026-11-15' } });
  bus.emit('wake'); await tick();
  assert.deepEqual(calls, [['save', '2026-11-16'], ['run']]);
});

test('first wake: already ran today → nothing, even after a restart', async () => {
  const { bus, calls } = setup({ brief: { lastDate: '2026-11-16' } });
  bus.emit('wake'); await tick();
  assert.deepEqual(calls, []);
});

test('first wake: auto off or onFirstWake off never runs', async () => {
  for (const brief of [{ auto: false }, { onFirstWake: false }]) {
    const { bus, calls } = setup({ brief });
    bus.emit('wake'); await tick();
    assert.deepEqual(calls, []);
  }
});

test('first wake: quiet hours never run and do not use up the day', async () => {
  const { bus, calls, state } = setup({ quiet: true });
  bus.emit('wake'); await tick();
  assert.deepEqual(calls, []);
  assert.equal(state.brief.lastDate, '');
});

test('first wake: run rejecting or saving throwing does not escape the bus handler', async () => {
  const a = setup({ run: async () => { throw new Error('x'); } });
  a.bus.emit('wake'); await tick();
  const b = setup();
  b.fw.stop();
  b.bus.emit('wake'); await tick();
  assert.deepEqual(b.calls, []);
});
