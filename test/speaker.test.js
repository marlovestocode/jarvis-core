const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fbank } = require('../src/core/voice/speaker/fbank');
const { createSpeaker } = require('../src/core/voice/speaker/speaker');
const { speechClips, enrollVoice } = require('../src/core/voice/speaker/enroll');
const { createBus } = require('../src/core/bus');
const { createVoiceController } = require('../src/core/voice/controller');
const { DEFAULTS } = require('../src/core/config');
const { noise, tone } = require('./helpers/pcm');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jspk-')), 'voiceprint.json');
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// fake onnxruntime: the "embedding" is a unit vector picked by `voice.dir` (index 0..255)
function fakeOrt(voice) {
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  return {
    Tensor,
    InferenceSession: { create: async () => ({ run: async ({ feats }) => {
      if (voice.fail) throw new Error('boom');
      assert.equal(feats.dims[0], 1); assert.equal(feats.dims[2], 80);
      const v = new Float32Array(256); v[voice.dir] = 1; v[(voice.dir + 1) % 256] = voice.mix || 0;
      return { embs: { data: v } };
    } }) },
  };
}
const secs = n => new Int16Array(16000 * n).map((_, i) => (i % 40) * 300 - 6000);

test('fbank: 1 s gives 98 frames x 80 bins, finite, mean-normalised; under one frame gives null', () => {
  const f = fbank(secs(1));
  assert.equal(f.frames, 98);
  assert.equal(f.data.length, 98 * 80);
  assert.ok(f.data.every(Number.isFinite));
  for (let b = 0; b < 80; b += 20) { let m = 0; for (let t = 0; t < f.frames; t++) m += f.data[t * 80 + b]; assert.ok(Math.abs(m / f.frames) < 1e-3); }
  assert.equal(fbank(new Int16Array(300)), null);
});

test('speaker: not enrolled, or model missing, means no gate (ok:true)', async () => {
  const voice = { dir: 0 };
  const a = createSpeaker({ ort: fakeOrt(voice), modelPath: 'm', profileFile: tmpFile(), exists: () => true });
  assert.equal(a.enrolled(), false);
  assert.equal((await a.verify(secs(2), 16000)).ok, true);
  const b = createSpeaker({ ort: fakeOrt(voice), modelPath: 'm', profileFile: tmpFile(), exists: () => false });
  assert.equal(b.available(), false);
  assert.equal((await b.enroll([{ pcm: secs(2), rate: 16000 }, { pcm: secs(2), rate: 16000 }]).catch(e => ({ ok: false, reason: e.message }))).ok, false);
});

test('speaker: enroll needs two clips of real speech; same voice passes, another voice is refused; persists', async () => {
  const voice = { dir: 3 }, file = tmpFile();
  const sp = createSpeaker({ ort: fakeOrt(voice), modelPath: 'm', profileFile: file, exists: () => true });
  assert.equal((await sp.enroll([{ pcm: secs(2), rate: 16000 }])).ok, false);
  assert.equal((await sp.enroll([{ pcm: secs(1), rate: 16000 }, { pcm: secs(1), rate: 16000 }])).ok, false, 'clips under 1.5 s do not count');
  assert.deepEqual(await sp.enroll([{ pcm: secs(2), rate: 16000 }, { pcm: secs(3), rate: 16000 }]), { ok: true, count: 2 });
  assert.equal(sp.enrolled(), true);
  let r = await sp.verify(secs(2), 16000);
  assert.equal(r.ok, true); assert.ok(r.score > 0.99);
  voice.dir = 100;
  r = await sp.verify(secs(2), 16000);
  assert.equal(r.ok, false); assert.ok(r.score < 0.1);
  const again = createSpeaker({ ort: fakeOrt(voice), modelPath: 'm', profileFile: file, exists: () => true });
  assert.equal(again.enrolled(), true, 'reloaded from the file');
  again.clear();
  assert.equal(again.enrolled(), false);
  assert.equal(fs.existsSync(file), false);
});

test('speaker: lenient lowers the bar by 0.1; too-short audio and model errors never lock the user out', async () => {
  const voice = { dir: 5 };
  const sp = createSpeaker({ ort: fakeOrt(voice), modelPath: 'm', profileFile: tmpFile(), exists: () => true, getConfig: () => ({ speakerThreshold: 0.45 }) });
  await sp.enroll([{ pcm: secs(2), rate: 16000 }, { pcm: secs(2), rate: 16000 }]);
  voice.dir = 5; voice.mix = 2.3;   // cos = 1/sqrt(1+2.3^2) ~ 0.399
  const strict = await sp.verify(secs(2), 16000), soft = await sp.verify(secs(2), 16000, { lenient: true });
  assert.equal(strict.ok, false); assert.equal(soft.ok, true);
  assert.equal((await sp.verify(new Int16Array(2000), 16000)).ok, true);
  voice.fail = true;
  const broken = await sp.verify(secs(2), 16000);
  assert.equal(broken.ok, true); assert.match(broken.reason, /boom/);
});

test('enroll: speechClips drops quiet frames and cuts ~3 s clips; enrollVoice records, restores the mic and enrolls', async () => {
  const quiet = { pcm: new Int16Array(320).fill(10), rate: 16000 }, loud = { pcm: new Int16Array(320).fill(3000), rate: 16000 };
  const frames = [...Array(50).fill(quiet), ...Array(400).fill(loud)];   // 8 s of speech
  const clips = speechClips(frames);
  assert.equal(clips.length, 3);
  assert.ok(clips.every(c => c.pcm.length >= 24000));
  assert.deepEqual(speechClips(Array(100).fill(quiet)), []);

  let started = 0, updated = 0, cancelled = 0, got = null;
  const ctx = { speaker: { available: () => true, enroll: async c => { got = c; return { ok: true, count: c.length }; } }, voice: { cancel: () => cancelled++ }, mic: { start: () => started++ }, updateMic: () => updated++ };
  const p = enrollVoice(ctx, { seconds: 1, wait: async () => { ctx.enrollBuf.push(...frames); } });
  assert.deepEqual(await p, { ok: true, count: 3 });
  assert.equal(ctx.enrollBuf, null);
  assert.deepEqual([started, updated, cancelled, got.length], [1, 1, 1, 3]);
  assert.equal((await enrollVoice({ ...ctx, speaker: { available: () => false } })).ok, false);
});

// ---- controller gate ----
function gateSetup({ enrolled, ok, gate = true }) {
  const bus = createBus(); const events = []; bus.on('*', e => events.push(e));
  const stt = { id: 'w', label: 'W', async status() { return { ready: true }; }, async transcribe() { return 'Jarvis, what time is it?'; } };
  const sends = [];
  const orchestrator = { busy: false, stop() {}, async send(id, text) { sends.push(text); return { reply: 'noon', stopped: false, sessionId: 's' }; } };
  const tts = { id: 't', label: 'T', async status() { return { ready: true }; }, speak() { return { levels: (async function* () {})(), done: Promise.resolve() }; } };
  const calls = [];
  const speaker = { enrolled: () => enrolled, async verify(pcm, rate, o) { calls.push(o); return ok ? { ok: true, score: 0.9 } : { ok: false, score: 0.12, threshold: 0.45 }; } };
  const wake = { id: 'whisper', label: 'W', kind: 'listen', async status() { return { ready: true }; } };
  const vc = createVoiceController({ bus, orchestrator, speaker, engines: { stt, tts, wake }, getConfig: () => ({ ...DEFAULTS, wakeEnabled: true, speakerGate: gate }), getSessionId: () => 's' });
  vc.applyWake();
  return { vc, events, sends, calls };
}
const feedAll = (vc, frames) => { for (const f of frames) vc.feed(f, 16000); };
const utterance = () => [...noise(300), ...tone(1200), ...noise(700)];

test('controller gate: another voice saying "Jarvis" is ignored and logged', async () => {
  const g = gateSetup({ enrolled: true, ok: false });
  feedAll(g.vc, utterance());
  await tick(30);
  assert.equal(g.sends.length, 0);
  assert.equal(g.events.filter(e => e.type === 'wake').length, 0);
  assert.ok(g.events.some(e => e.type === 'log' && /not yours/.test(e.text)));
  assert.ok(g.events.some(e => e.type === 'speaker' && e.ok === false));
  assert.equal(g.vc.mode, 'idle');
});

test('controller gate: your voice wakes; not enrolled or gate off means no check at all', async () => {
  for (const cfg of [{ enrolled: true, ok: true }, { enrolled: false, ok: false }, { enrolled: true, ok: false, gate: false }]) {
    const g = gateSetup(cfg);
    feedAll(g.vc, utterance());
    await tick(30);
    assert.deepEqual(g.sends, ['what time is it?'], JSON.stringify(cfg));
    if (!cfg.enrolled || cfg.gate === false) assert.equal(g.calls.length, 0);
  }
});
