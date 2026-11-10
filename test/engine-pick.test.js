const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngineRegistries } = require('../src/core/voice/engines');
const { createEnginePick } = require('../src/core/voice/engine-pick');

function rig(piperAvailable) {
  const regs = createEngineRegistries();
  regs.tts.add({ id: 'piper', label: 'Piper', available: () => piperAvailable(), async status() { return { ready: true }; }, speak() {} });
  regs.tts.add({ id: 'windows', label: 'Windows speech', async status() { return { ready: true }; }, speak() {} });
  const logs = [];
  let cfg = { engines: { stt: 'whisper', tts: 'piper', wake: 'whisper' } };
  const pick = createEnginePick({ registries: regs, getConfig: () => cfg, log: m => logs.push(m) });
  return { pick, logs, setCfg: c => { cfg = c; } };
}

test('engine pick: the configured engine when it is available; no warning', () => {
  const r = rig(() => true);
  assert.equal(r.pick('tts').id, 'piper');
  assert.deepEqual(r.logs, []);
});

test('engine pick: Piper not installed → Windows voice, one warning naming the reason', () => {
  const r = rig(() => false);
  for (let i = 0; i < 5; i++) assert.equal(r.pick('tts').id, 'windows');
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /Text-to-speech: Piper is not installed; using Windows speech/);
});

test('engine pick: an unknown configured engine → fallback, warning says it is unknown', () => {
  const r = rig(() => true);
  r.setCfg({ engines: { tts: 'elevenlabs' } });
  assert.equal(r.pick('tts').id, 'windows');
  assert.match(r.logs[0], /Text-to-speech: no engine "elevenlabs"; using Windows speech/);
});

test('engine pick: warns again only if the reason changes (e.g. installed later, then removed)', () => {
  let ok = false;
  const r = rig(() => ok);
  r.pick('tts'); ok = true; r.pick('tts'); ok = false; r.pick('tts');
  assert.equal(r.logs.length, 2);
});

test('engine pick: no Windows engine either → the None engine', () => {
  const regs = createEngineRegistries();
  const logs = [];
  const pick = createEnginePick({ registries: regs, getConfig: () => ({ engines: { stt: 'whisper' } }), log: m => logs.push(m) });
  assert.equal(pick('stt').id, 'none');
  assert.match(logs[0], /Speech-to-text: no engine "whisper"; using None/);
});
