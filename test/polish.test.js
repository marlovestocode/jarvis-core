const test = require('node:test');
const assert = require('node:assert/strict');
const { polishPcm } = require('../src/core/voice/polish');

const RATE = 22050;
const tone = (n, amp) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 7) * amp));
const quiet = n => new Int16Array(n);
const join = (...parts) => { const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const peak = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('polish: long dead air at both ends is cut to a short natural lead and tail', () => {
  const pcm = join(quiet(RATE), tone(RATE / 2, 9000), quiet(RATE));
  const out = polishPcm(pcm, RATE);
  const ms = out.length / RATE * 1000;
  assert.ok(ms > 500 + 90 && ms < 500 + 90 + 200 + 20, `length ${ms} ms`);
});

test('polish: both ends fade, so a sentence cannot click', () => {
  const out = polishPcm(join(quiet(500), tone(RATE / 2, 12000), quiet(500)), RATE);
  assert.ok(Math.abs(out[0]) < 50 && Math.abs(out.at(-1)) < 50);
  const loud = polishPcm(tone(RATE / 2, 12000), RATE);
  assert.ok(Math.abs(loud[0]) < 5 && Math.abs(loud.at(-1)) < 5, 'audio that starts and ends loud still fades');
});

test('polish: levels are brought to a steady peak, and hiss is not boosted without limit', () => {
  const soft = polishPcm(tone(RATE / 2, 5000), RATE);
  assert.ok(peak(soft) > 5000 * 1.9 && peak(soft) <= 0.88 * 32767 + 2, `peak ${peak(soft)}`);
  const loud = polishPcm(tone(RATE / 2, 32000), RATE);
  assert.ok(peak(loud) <= 0.88 * 32767 + 2, 'loud audio is brought down');
  const hiss = polishPcm(tone(RATE / 2, 300), RATE);
  assert.ok(peak(hiss) <= 300 * 2.2 + 2, 'gain is capped');
});

test('polish: a DC offset is removed; silence and tiny input come back unchanged', () => {
  const dc = Int16Array.from(tone(RATE / 2, 8000), v => v + 3000);
  const out = polishPcm(dc, RATE);
  const mean = out.reduce((a, v) => a + v, 0) / out.length;
  assert.ok(Math.abs(mean) < 300, `mean ${mean}`);
  const silent = quiet(2000);
  assert.equal(polishPcm(silent, RATE), silent);
  const tiny = tone(10, 9000);
  assert.equal(polishPcm(tiny, RATE), tiny);
});

test('polish: soft consonants at the edges of a sentence are kept (the s of "Sir", a final t)', () => {
  // 120 ms of soft fricative (amplitude 120, about -49 dBFS), then the vowel, then a soft final stop
  const hiss = n => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i * 2.1) * 120));
  const pcm = join(quiet(RATE), hiss(Math.round(RATE * 0.12)), tone(RATE / 3, 9000), hiss(Math.round(RATE * 0.06)), quiet(RATE));
  const out = polishPcm(pcm, RATE);
  const soft = a => a.reduce((n, v) => n + (Math.abs(v) > 20 ? 1 : 0), 0);
  const inSoft = soft(pcm.subarray(RATE, RATE + Math.round(RATE * 0.12)));
  assert.ok(soft(out.subarray(0, Math.round(RATE * 0.12) + Math.round(RATE * 0.09))) >= inSoft * 0.9, 'the soft start survives');
  const tailSoft = soft(pcm.subarray(RATE + Math.round(RATE * 0.12) + Math.round(RATE / 3), RATE + Math.round(RATE * 0.12) + Math.round(RATE / 3) + Math.round(RATE * 0.06)));
  const tailAt = out.length - Math.round(RATE * 0.2) - Math.round(RATE * 0.06);
  assert.ok(soft(out.subarray(tailAt, tailAt + Math.round(RATE * 0.06))) >= tailSoft * 0.9, 'the soft ending survives');
});
