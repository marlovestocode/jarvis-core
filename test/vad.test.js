const test = require('node:test');
const assert = require('node:assert/strict');
const { createVad } = require('../src/core/voice/vad');
const { SR, noise, tone } = require('./helpers/pcm');

function run(vad, frames) {
  const out = [];
  frames.forEach((f, i) => { const r = vad.push(f, SR); if (r !== 'none') out.push([r, (i + 1) * 20]); });
  return out;
}

test('vad start then end after 800 ms silence', () => {
  const vad = createVad();
  const ev = run(vad, [...noise(300), ...tone(1000), ...noise(900)]);
  assert.equal(ev.length, 2);
  assert.equal(ev[0][0], 'start');
  assert.ok(ev[0][1] >= 300 && ev[0][1] <= 400, `start at ${ev[0][1]}`);
  assert.equal(ev[1][0], 'end');
  assert.ok(ev[1][1] >= 300 + 1000 + 800 && ev[1][1] <= 300 + 1000 + 840, `end at ${ev[1][1]}`);
  assert.ok(vad.rms < 0.02);
});

test('vad max at 30 s', () => {
  const vad = createVad();
  const ev = run(vad, [...noise(300), ...tone(31000)]);
  assert.deepEqual(ev.map(e => e[0]), ['start', 'max']);
  assert.ok(Math.abs(ev[1][1] - 30000) <= 20, `max at ${ev[1][1]}`);
});

test('vad: short pause under 800 ms does not end', () => {
  const vad = createVad();
  const ev = run(vad, [...noise(300), ...tone(500), ...noise(500), ...tone(500), ...noise(900)]);
  assert.deepEqual(ev.map(e => e[0]), ['start', 'end']);
});

test('vad: gain raises the threshold; reset clears state', () => {
  const vad = createVad();
  vad.setGain(3);
  // rms ≈ 0.035: above 0.02, below 0.06
  assert.deepEqual(run(vad, [...noise(300), ...tone(600, 0.05)]), []);
  vad.reset();
  vad.setGain(1);
  assert.equal(run(vad, [...noise(300), ...tone(600, 0.05)])[0][0], 'start');
});

test('vad: noise floor ×3 sets threshold when room is loud', () => {
  const vad = createVad();
  // floor ≈ 0.03 → threshold ≈ 0.09; tone rms ≈ 0.057 must not trigger
  const ev = run(vad, [...noise(300, 0.03), ...tone(600, 0.08)]);
  assert.deepEqual(ev, []);
});
