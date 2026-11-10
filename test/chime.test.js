const test = require('node:test');
const assert = require('node:assert/strict');
const { chime } = require('../src/core/voice/chime');

test('chime: short, quiet, starts and ends at silence (no click)', () => {
  const p = chime();
  assert.ok(p.length > 22050 * 0.1 && p.length < 22050 * 0.25);
  const peak = Math.max(...p.map(Math.abs));
  assert.ok(peak > 2000 && peak < 0.2 * 32768, `peak ${peak}`);
  assert.ok(Math.abs(p[0]) < 50 && Math.abs(p.at(-1)) < 300);
});
