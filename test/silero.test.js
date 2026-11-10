const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSilero, createSileroStream } = require('../src/core/voice/silero');

const { fakeOrt } = require('./helpers/fake-ort');
const pcm = (n, v = 1000) => new Int16Array(n).fill(v);
const drain = s => s.idle();

test('silero: load reads the session names and rejects an unknown signature', async () => {
  const ok = await loadSilero({ modelPath: 'x.onnx', ort: fakeOrt().ort });
  assert.deepEqual(ok.names, { input: 'input', state: 'state', sr: 'sr', output: 'output', stateN: 'stateN' });
  await assert.rejects(loadSilero({ modelPath: 'x.onnx', ort: fakeOrt({ inputNames: ['input', 'h', 'c', 'sr'] }).ort }), /signature/);
});

test('silero: 320-sample mic frames are re-framed to 512 with 64 samples of context', async () => {
  const f = fakeOrt({ probs: [0.1, 0.2, 0.3, 0.4, 0.5] });
  const model = await loadSilero({ modelPath: 'x', ort: f.ort });
  const got = [];
  const s = createSileroStream(model, { onProb: p => got.push(p) });
  for (let i = 0; i < 8; i++) s.push(pcm(320, i + 1), 16000);   // 2560 samples = 5 frames of 512
  await drain(s);
  assert.equal(f.calls.length, 5);
  assert.deepEqual(got.map(p => +p.toFixed(1)), [0.1, 0.2, 0.3, 0.4, 0.5]);
  const first = f.calls[0], second = f.calls[1];
  assert.deepEqual(first.input.dims, [1, 576]);
  assert.equal(first.input.data[0], 0);                          // empty context at start
  assert.equal(first.input.data[64], 1 / 32768);                // samples scaled to [-1, 1]
  assert.deepEqual(Array.from(second.input.data.slice(0, 64)), Array.from(first.input.data.slice(-64)));  // context carried
  assert.equal(first.sr.type, 'int64');
  assert.equal(first.sr.data[0], 16000n);
  assert.deepEqual(first.state.dims, [2, 1, 128]);
  assert.equal(first.state.data[0], 0);
  assert.equal(second.state.data[0], 1);                         // stateN of run 1 fed to run 2
});

test('silero: a remainder under 512 samples waits for the next push', async () => {
  const f = fakeOrt();
  const s = createSileroStream(await loadSilero({ modelPath: 'x', ort: f.ort }));
  s.push(pcm(500), 16000); await drain(s);
  assert.equal(f.calls.length, 0);
  s.push(pcm(20), 16000); await drain(s);
  assert.equal(f.calls.length, 1);
});

test('silero: reset clears state, context and remainder, and drops results still in flight', async () => {
  const f = fakeOrt({ probs: [0.9, 0.9, 0.2] });
  const got = [];
  const s = createSileroStream(await loadSilero({ modelPath: 'x', ort: f.ort }), { onProb: p => got.push(p) });
  s.push(pcm(1024), 16000);     // two frames queued
  s.push(pcm(100), 16000);      // remainder
  s.reset();
  await drain(s);
  assert.deepEqual(got, []);
  s.push(pcm(512, 7), 16000); await drain(s);
  const last = f.calls.at(-1);
  assert.equal(last.input.data[0], 0);                           // fresh context
  assert.equal(last.input.data[64], 7 / 32768);                  // old remainder gone
  assert.equal(last.state.data[0], 0);                           // fresh state
});

test('silero: two streams on one model keep separate state', async () => {
  const f = fakeOrt();
  const model = await loadSilero({ modelPath: 'x', ort: f.ort });
  const a = createSileroStream(model), b = createSileroStream(model);
  a.push(pcm(512), 16000); await drain(a);
  b.push(pcm(512), 16000); await drain(b);
  assert.equal(f.calls[1].state.data[0], 0);                     // b did not inherit a's state
});

test('silero: a non-16 kHz rate or a failing run is reported through onError', async () => {
  const errs = [];
  const f = fakeOrt({ fail: 1 });
  const s = createSileroStream(await loadSilero({ modelPath: 'x', ort: f.ort }), { onError: e => errs.push(e.message) });
  s.push(pcm(320), 48000);
  s.push(pcm(512), 16000); await drain(s);
  assert.match(errs[0], /16000/);
  assert.match(errs[1], /boom/);
});

test('silero: session runs single-threaded (the default pool spins every core: ~2 cores for one 32 ms frame stream)', async () => {
  const f = fakeOrt();
  await loadSilero({ modelPath: 'x', ort: f.ort });
  assert.deepEqual(f.created[0], { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' });
});
