const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createLiveState, TOOL_TTL_MS, MAX_TOOLS } = require('../src/core/livestate');

function setup(opts = {}) {
  const bus = createBus();
  const ls = createLiveState({ bus, ...opts });
  return { bus, ls };
}

test('fills the ring from bus events', () => {
  const { bus, ls } = setup();
  bus.emit('state', { state: 'thinking' });
  bus.emit('route', { tier: 'fast', think: false, reason: 'chat', model: 'm1' });
  bus.emit('tool', { id: 1, name: 'youtube_music', phase: 'start' });
  bus.emit('tool', { id: 1, name: 'youtube_music', phase: 'end', ok: true });
  bus.emit('turn', { ms: 420 });
  const snap = ls.snapshot();
  assert.equal(snap.voice, 'thinking');
  assert.equal(snap.tools.length, 1);
  assert.equal(snap.tools[0].name, 'youtube_music');
  assert.equal(snap.tools[0].ok, true);
  assert.equal(snap.route.tier, 'fast');
  assert.equal(snap.turn.ms, 420);
});

test('only tool end events are recorded; start is ignored', () => {
  const { bus, ls } = setup();
  bus.emit('tool', { id: 1, name: 'a', phase: 'start' });
  assert.equal(ls.snapshot().tools.length, 0);
});

test('caps tools at MAX_TOOLS (8), newest last', () => {
  const { bus, ls } = setup();
  assert.equal(MAX_TOOLS, 8);
  for (let i = 1; i <= 12; i++) bus.emit('tool', { name: `t${i}`, phase: 'end', ok: true });
  const { tools } = ls.snapshot();
  assert.equal(tools.length, 8);
  assert.equal(tools[7].name, 't12');
  assert.equal(tools[0].name, 't5');
});

test('expires tools older than TOOL_TTL_MS', () => {
  let clock = 1000;
  const { bus, ls } = setup({ now: () => clock });
  assert.equal(TOOL_TTL_MS, 10 * 60 * 1000);
  bus.emit('tool', { name: 'old', phase: 'end', ok: true });
  clock += TOOL_TTL_MS + 1;
  bus.emit('tool', { name: 'new', phase: 'end', ok: true });
  assert.deepEqual(ls.snapshot().tools.map((t) => t.name), ['new']);
});

test('never stores args or output', () => {
  const { bus, ls } = setup();
  bus.emit('tool', { name: 'x', phase: 'end', ok: true, args: { secret: 1 }, text: 'x-output-body' });
  const s = JSON.stringify(ls.snapshot());
  assert.ok(!s.includes('secret'));
  assert.ok(!s.includes('x-output-body'));
});

test('register adds a source key; a throwing source is skipped and logged once', () => {
  const logs = [];
  const { ls } = setup({ log: (m) => logs.push(m) });
  ls.register('music', () => ({ playing: true }));
  ls.register('bad', () => { throw new Error('boom'); });
  ls.register('str', () => 'nope');
  ls.register('nul', () => null);
  const a = ls.snapshot();
  const b = ls.snapshot();
  assert.deepEqual(a.music, { playing: true });
  assert.ok(!('bad' in a));
  assert.ok(!('str' in a));
  assert.ok(!('nul' in a));
  assert.ok(!('bad' in b));
  assert.equal(logs.length, 1);
});

test('snapshot returns a fresh object', () => {
  const { bus, ls } = setup();
  bus.emit('tool', { name: 'a', phase: 'end', ok: true });
  const s1 = ls.snapshot();
  s1.tools[0].name = 'mutated';
  s1.tools.push({});
  s1.voice = 'x';
  const s2 = ls.snapshot();
  assert.equal(s2.tools.length, 1);
  assert.equal(s2.tools[0].name, 'a');
  assert.equal(s2.voice, null);
});

test('close() unsubscribes', () => {
  const { bus, ls } = setup();
  ls.close();
  bus.emit('state', { state: 'speaking' });
  bus.emit('tool', { name: 'a', phase: 'end', ok: true });
  const s = ls.snapshot();
  assert.equal(s.voice, null);
  assert.equal(s.tools.length, 0);
});

test('tolerates events with missing fields', () => {
  const { bus, ls } = setup();
  assert.doesNotThrow(() => {
    bus.emit('tool', { phase: 'end' });
    bus.emit('state', {});
    bus.emit('route', {});
    bus.emit('turn', {});
  });
  assert.doesNotThrow(() => ls.snapshot());
});
