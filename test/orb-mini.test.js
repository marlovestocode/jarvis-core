const test = require('node:test');
const assert = require('node:assert/strict');
const { createModel } = require('../src/ui/orb-mini');

test('mini orb: token adds spark rings, max 16', () => {
  const m = createModel();
  for (let i = 0; i < 40; i++) m.event({ type: 'token', text: 'x' });
  assert.equal(m.snapshot().sparks.length, 16);
  m.step(5);
  assert.equal(m.snapshot().sparks.length, 0);
});

test('mini orb: state picks core color; error flashes then decays', () => {
  const m = createModel();
  assert.equal(m.snapshot().color, 'idle');
  m.event({ type: 'state', state: 'thinking' });
  assert.equal(m.snapshot().color, 'thinking');
  m.event({ type: 'state', state: 'error' });
  assert.equal(m.snapshot().flash, 1);
  m.step(2);
  assert.equal(m.snapshot().flash, 0);
});

test('mini orb: speaking pulse follows tts level, listening follows mic', () => {
  const m = createModel();
  m.event({ type: 'state', state: 'speaking' });
  m.event({ type: 'level', source: 'tts', rms: 0.8 });
  assert.ok(m.snapshot().pulse > 0.5);
  m.event({ type: 'level', source: 'mic', rms: 0.9 });
  assert.ok(m.snapshot().pulse <= 0.8 + 1e-9);
});
