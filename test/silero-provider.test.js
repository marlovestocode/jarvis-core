const test = require('node:test');
const assert = require('node:assert/strict');
const { createSileroProvider } = require('../src/core/voice/silero-provider');
const { fakeOrt } = require('./helpers/fake-ort');

const tick = () => new Promise(r => setImmediate(r));

test('silero provider: off → null and nothing loaded', () => {
  let loads = 0;
  const p = createSileroProvider({ modelPath: 'm', isOn: () => false, loadOrt: () => { loads++; return fakeOrt().ort; }, exists: () => true, log: () => {} });
  assert.equal(p.getModel(), null);
  assert.equal(loads, 0);
});

test('silero provider: on → null while loading, the model once loaded, loaded only once', async () => {
  let loads = 0;
  const logs = [];
  const p = createSileroProvider({ modelPath: 'm', isOn: () => true, loadOrt: () => { loads++; return fakeOrt().ort; }, exists: () => true, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(p.getModel(), null);
  await tick(); await tick();
  assert.deepEqual(logs, ['Silero VAD loaded']);
  const m = p.getModel();
  assert.ok(m && m.names && m.run);
  assert.equal(p.getModel(), m);
  assert.equal(loads, 1);
});

test('silero provider: missing model, missing runtime or a bad load → energy, one warning each', async () => {
  for (const [name, opts, re] of [
    ['missing model', { exists: () => false }, /not installed/],
    ['missing runtime', { loadOrt: () => { throw new Error("Cannot find module 'onnxruntime-node'"); } }, /onnxruntime/],
    ['bad load', { loadOrt: () => ({ ...fakeOrt().ort, InferenceSession: { create: async () => { throw new Error('corrupt'); } } }) }, /corrupt/],
  ]) {
    const logs = [];
    const p = createSileroProvider({ modelPath: 'm', isOn: () => true, loadOrt: () => fakeOrt().ort, exists: () => true, log: (...a) => logs.push(a.join(' ')), ...opts });
    for (let i = 0; i < 3; i++) { assert.equal(p.getModel(), null, name); await tick(); await tick(); }
    assert.equal(logs.length, 1, name);
    assert.match(logs[0], /Silero VAD/);
    assert.match(logs[0], re);
    assert.match(logs[0], /energy/);
  }
});

test('silero provider: a model failing at run time is reported once and not used again', async () => {
  const logs = [];
  const p = createSileroProvider({ modelPath: 'm', isOn: () => true, loadOrt: () => fakeOrt().ort, exists: () => true, log: (...a) => logs.push(a.join(' ')) });
  p.getModel(); await tick(); await tick();
  p.onError(new Error('boom')); p.onError(new Error('boom again'));
  const warns = logs.filter(l => l !== 'Silero VAD loaded');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /boom/);
  assert.equal(p.getModel(), null);
});
