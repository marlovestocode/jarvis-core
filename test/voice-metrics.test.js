const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../scripts/lib/voice-metrics');
const { createVad } = require('../src/core/voice/vad');
const { noise, tone } = require('./helpers/pcm');

const pcm = frames => { const o = new Int16Array(frames.length * 320); frames.forEach((f, i) => o.set(f, i * 320)); return o; };

test('wer: pooled errors, number words and punctuation normalised', () => {
  assert.deepEqual(M.wer('Jarvis, set a timer for 10 minutes', 'jarvis set a timer for ten minutes.'), { errors: 0, ref: 7 });
  assert.deepEqual(M.wer('open Discord now', 'open this cord now'), { errors: 2, ref: 3 });
  assert.deepEqual(M.wer('hello', ''), { errors: 1, ref: 1 });
});

test('percentile: nearest rank', () => {
  assert.equal(M.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(M.percentile([1, 2, 3, 4], 95), 4);
  assert.equal(M.percentile([], 50), null);
});

test('runVad/scoreClip: detects tone span, flags a mid-speech cut', async () => {
  const clip = { speechStartMs: 400, speechEndMs: 1400 };
  const ok = pcm([...noise(400), ...tone(1000), ...noise(1000)]);
  const r = await M.runVad(createVad({ silenceMs: 700 }), ok, 700);
  const s = M.scoreClip(r, clip);
  assert.equal(s.missed, false); assert.equal(s.falseStart, false); assert.equal(s.earlyCut, false);
  // a 900 ms pause inside "speech" with silenceMs 700 is cut early
  const gap = pcm([...noise(400), ...tone(500), ...noise(900), ...tone(500), ...noise(1000)]);
  const r2 = await M.runVad(createVad({ silenceMs: 700 }), gap, 700);
  const sc = M.scoreClip(r2, { speechStartMs: 400, speechEndMs: 2300, pauses: [{ startMs: 900, endMs: 1800 }] });
  assert.equal(sc.earlyCut, true); assert.equal(sc.pauseCut, true);
});

test('countFalseStarts: silence none, bursts counted', async () => {
  assert.equal(await M.countFalseStarts(createVad(), pcm(noise(5000))), 0);
  assert.equal(await M.countFalseStarts(createVad({ silenceMs: 300 }), pcm([...noise(500), ...tone(300), ...noise(1500), ...noise(500), ...tone(300), ...noise(1500)])), 2);
});

test('runVad: waits for a model VAD queue each frame, so latched events land in real time order', async () => {
  const { createModelVad } = require('../src/core/voice/vad-model');
  const { loadSilero } = require('../src/core/voice/silero');
  const { fakeOrt } = require('./helpers/fake-ort');
  // 32 ms frames: speech for frames 10..39 (320..1280 ms), quiet after
  const model = await loadSilero({ modelPath: 'x', ort: fakeOrt({ probs: i => (i >= 10 && i < 40 ? 0.9 : 0.05) }).ort });
  const r = await M.runVad(createModelVad({ getModel: () => model, silenceMs: 320 }), new Int16Array(16000 * 3), 320);
  assert.ok(r.start > 400 && r.start < 480, 'start ' + r.start);   // 3rd loud frame ends at 416 ms, latched to the next 20 ms push
  assert.ok(r.end > 1600 && r.end < 1680, 'end ' + r.end);         // 10 quiet frames end at 1600 ms
  const model2 = await loadSilero({ modelPath: 'x', ort: fakeOrt({ probs: i => (i % 40 < 5 ? 0.9 : 0.05) }).ort });
  assert.equal(await M.countFalseStarts(createModelVad({ getModel: () => model2, silenceMs: 320 }), new Int16Array(16000 * 5)), 4);
});
