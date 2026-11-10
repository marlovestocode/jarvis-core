const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelVad } = require('../src/core/voice/vad-model');
const { createVad } = require('../src/core/voice/vad');
const { loadSilero } = require('../src/core/voice/silero');
const { fakeOrt } = require('./helpers/fake-ort');
const { SR, noise, tone } = require('./helpers/pcm');

// One 20 ms mic frame per push; Silero frames are 512 samples (32 ms), so a probability lands
// every 1.6 pushes. Each push is followed by draining the queue, like real time would.
const frame = () => new Int16Array(320).fill(500);
async function drive(vad, pushes) {
  const out = [];
  for (let i = 0; i < pushes; i++) {
    const r = vad.push(frame(), SR);
    if (r !== 'none') out.push({ i, r });
    await vad.idle();
  }
  return out;
}
async function modelOf(probs, opts) {
  const f = fakeOrt({ probs, ...opts });
  return { f, model: await loadSilero({ modelPath: 'x', ort: f.ort }) };
}
// frame count (512) reached after n pushes of 320
const pushesFor = frames => Math.ceil(frames * 512 / 320);

test('model vad: without a model it behaves exactly like the energy VAD', () => {
  const a = createModelVad({ getModel: () => null, silenceMs: 500 });
  const b = createVad({ silenceMs: 500 });
  for (const f of [...noise(300), ...tone(600), ...noise(800)]) {
    assert.equal(a.push(f, SR), b.push(f, SR));
    assert.equal(a.rms, b.rms);
  }
  assert.equal(a.heard, b.heard);
});

test('model vad: start needs 3 frames over 0.5, and is returned by the next push (latched)', async () => {
  const { model } = await modelOf(i => (i >= 2 ? 0.9 : 0.1));
  const vad = createModelVad({ getModel: () => model });
  const ev = await drive(vad, 12);
  assert.equal(ev[0].r, 'start');
  assert.equal(ev[0].i, pushesFor(5));           // frame 5 (3rd loud) done at that push; returned on the one after
  assert.equal(vad.heard, true);
});

test('model vad: two loud frames then quiet is not speech', async () => {
  const { model } = await modelOf([0.9, 0.9, 0.1, 0.1, 0.1, 0.1]);
  const vad = createModelVad({ getModel: () => model });
  assert.deepEqual(await drive(vad, 10), []);
  assert.equal(vad.heard, false);
});

test('model vad: end after silenceMs under 0.35; 0.35..0.5 keeps the speech going (hysteresis)', async () => {
  // 3 loud, then 10 frames at 0.4 (not quiet), then quiet
  const { model } = await modelOf(i => (i < 3 ? 0.9 : i < 13 ? 0.4 : 0.05));
  const vad = createModelVad({ getModel: () => model, silenceMs: 320 });   // 10 frames of 32 ms
  const ev = await drive(vad, 60);
  assert.deepEqual(ev.map(e => e.r), ['start', 'end']);
  assert.ok(ev[1].i >= pushesFor(23), `end at push ${ev[1].i} came before 10 quiet frames after the 0.4 run`);
  assert.equal(vad.push(frame(), SR), 'none');    // done until reset
});

test('model vad: a pause shorter than silenceMs does not end the capture', async () => {
  // speech, 400 ms pause (12 frames), speech, long quiet
  const { model } = await modelOf(i => (i < 10 ? 0.9 : i < 22 ? 0.05 : i < 32 ? 0.9 : 0.05));
  const vad = createModelVad({ getModel: () => model, silenceMs: 450 });
  const ev = await drive(vad, 90);
  assert.deepEqual(ev.map(e => e.r), ['start', 'end']);
  assert.ok(ev[1].i > pushesFor(32));
});

test('model vad: max after maxMs even with speech still going', async () => {
  const { model } = await modelOf(() => 0.9);
  const vad = createModelVad({ getModel: () => model, maxMs: 400 });
  const ev = await drive(vad, 30);
  assert.deepEqual(ev.map(e => e.r), ['start', 'max']);
  assert.equal(ev[1].i, 19);                     // 20 pushes × 20 ms = 400 ms
});

test('model vad: setGain > 1 needs 0.8 for 5 frames (speaking mode)', async () => {
  const { model } = await modelOf(i => (i < 4 ? 0.85 : i < 10 ? 0.7 : i < 15 ? 0.85 : 0.1));
  const vad = createModelVad({ getModel: () => model });
  vad.setGain(3);
  const ev = await drive(vad, 40);
  assert.deepEqual(ev.map(e => e.r).slice(0, 1), ['start']);
  assert.ok(ev[0].i > pushesFor(15) - 1, 'start only after the 5-frame run at 0.85');
});

test('model vad: reset clears speech, pending events and the model stream', async () => {
  const { model, f } = await modelOf(i => (i < 3 ? 0.9 : 0.1));
  const vad = createModelVad({ getModel: () => model });
  for (let i = 0; i < pushesFor(3); i++) vad.push(frame(), SR);
  await vad.idle();
  vad.reset();
  assert.equal(vad.heard, false);
  assert.equal(vad.push(frame(), SR), 'none');    // the start latched before reset is gone
  vad.push(frame(), SR);                          // 640 samples: one fresh 512 frame runs
  await vad.idle();
  const last = f.calls.at(-1);
  assert.equal(last.state.data[0], 0);
});

test('model vad: rms is the energy of the last frame (level meter)', async () => {
  const { model } = await modelOf([]);
  const vad = createModelVad({ getModel: () => model });
  vad.push(new Int16Array(320).fill(16384), SR);
  assert.ok(Math.abs(vad.rms - 0.5) < 1e-6);
});

test('model vad: the model is picked up at reset, not mid-capture', async () => {
  let m = null;
  const { model } = await modelOf(() => 0.9);
  const vad = createModelVad({ getModel: () => m });
  m = model;
  assert.deepEqual(await drive(vad, 10), []);   // still energy (quiet 500-level frames): no start
  vad.reset();
  assert.equal((await drive(vad, 10))[0].r, 'start');
});

test('model vad: a failing run reports once, ends a heard capture, then falls back to energy', async () => {
  const errs = [];
  const { model } = await modelOf(() => 0.9, { fail: 5 });
  const vad = createModelVad({ getModel: () => model, onError: e => errs.push(e.message) });
  const ev = await drive(vad, 12);
  assert.deepEqual(ev.map(e => e.r), ['start', 'end']);
  vad.reset();
  const e = createVad();
  for (const f of [...noise(300), ...tone(600)]) assert.equal(vad.push(f, SR), e.push(f, SR));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /boom/);
});
