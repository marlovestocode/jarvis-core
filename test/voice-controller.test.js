const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createVoiceController } = require('../src/core/voice/controller');
const { createEngineRegistries } = require('../src/core/voice/engines');
const { DEFAULTS } = require('../src/core/config');
const { SR, noise, tone } = require('./helpers/pcm');

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

function fakeOrchestrator(reply = 'It is noon.', bus) {
  const sends = [];
  return {
    sends,
    busy: false,
    stopped: 0,
    async send(id, text, opts) {
      sends.push({ id, text, opts });
      bus?.emit('state', { state: 'thinking' });
      return { reply, stopped: false, sessionId: id || 'new-id' };
    },
    stop() { this.stopped++; },
  };
}

function fakeStt(text = 'what time is it') {
  return { id: 'fake', label: 'Fake STT', calls: [], async status() { return { ready: true }; },
    async transcribe(pcm, sr) { this.calls.push({ samples: pcm.length, sr }); return text; } };
}

// TTS that speaks until its signal aborts or `finish()` is called.
function fakeTts() {
  const tts = {
    id: 'fake', label: 'Fake TTS', spoken: [], aborted: 0, finish: null,
    async status() { return { ready: true }; },
    speak(text, { rate, signal }) {
      tts.spoken.push({ text, rate });
      let resolve;
      const done = new Promise(r => { resolve = r; });
      tts.finish = () => resolve();
      signal?.addEventListener('abort', () => { tts.aborted++; resolve(); }, { once: true });
      async function* levels() { yield 0.7; yield 0.3; }
      return { levels: levels(), done };
    },
  };
  return tts;
}

function setup({ stt = fakeStt(), tts = fakeTts(), reply } = {}) {
  const bus = createBus();
  const events = [];
  bus.on('*', e => events.push(e));
  const orchestrator = fakeOrchestrator(reply, bus);
  const vc = createVoiceController({
    bus, orchestrator, engines: { stt, tts, wake: null },
    getConfig: () => ({ ...DEFAULTS, voiceRate: 1.5 }), getSessionId: () => 'sess-1',
  });
  return { bus, events, orchestrator, vc, stt, tts };
}
const states = evs => evs.filter(e => e.type === 'state').map(e => e.state);
const feedAll = (vc, frames) => { for (const f of frames) vc.feed(f, SR); };

test('controller: full voice turn calls stt, send(voice), tts', async () => {
  const { events, orchestrator, vc, stt, tts } = setup();
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(1000), ...noise(900)]);
  await tick(20);
  assert.equal(stt.calls.length, 1);
  assert.equal(stt.calls[0].sr, SR);
  assert.ok(stt.calls[0].samples >= SR * 1.9);
  assert.deepEqual(orchestrator.sends.map(s => [s.id, s.text, s.opts.source]), [['sess-1', 'what time is it', 'voice']]);
  assert.deepEqual(tts.spoken, [{ text: 'It is noon.', rate: 1.5 }]);
  assert.equal(vc.speaking, true);
  assert.ok(events.some(e => e.type === 'level' && e.source === 'mic'));
  await tick(5);
  assert.ok(events.some(e => e.type === 'level' && e.source === 'tts' && e.rms === 0.7));
  tts.finish();
  await tick(5);
  assert.deepEqual(states(events), ['listening', 'thinking', 'speaking', 'idle']);
  assert.equal(vc.speaking, false);
});

test('speech during speaking at normal level is ignored, at ×3 level barges in', async () => {
  const { events, vc, tts } = setup();
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(800), ...noise(900)]);
  await tick(20);
  assert.equal(vc.speaking, true);
  // echo-level speech (rms ≈ 0.035: over the normal threshold, under ×3) is ignored
  feedAll(vc, [...noise(300), ...tone(600, 0.05)]);
  await tick(5);
  assert.equal(vc.speaking, true);
  assert.equal(tts.aborted, 0);
  // loud speech barges in: TTS cut, listening again
  feedAll(vc, tone(200, 0.4));
  await tick(5);
  assert.equal(tts.aborted, 1);
  assert.equal(vc.speaking, false);
  assert.equal(states(events).at(-1), 'listening');
});

test('empty transcript → idle, no send', async () => {
  const { events, orchestrator, vc } = setup({ stt: fakeStt('   ') });
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
  await tick(20);
  assert.equal(orchestrator.sends.length, 0);
  assert.equal(states(events).at(-1), 'idle');
});

test('no speech before max capture → idle, no stt', async () => {
  const stt = fakeStt();
  const { events, vc } = setup({ stt });
  vc.listen();
  feedAll(vc, noise(30100));
  await tick(10);
  assert.equal(stt.calls.length, 0);
  assert.equal(states(events).at(-1), 'idle');
});

test('tts throws → reply still in chat, state idle, one log event', async () => {
  const tts = { id: 'bad', label: 'Bad', async status() { return { ready: true }; }, speak() { throw new Error('SAPI gone'); } };
  const { events, orchestrator, vc } = setup({ tts });
  for (let i = 0; i < 2; i++) {
    vc.listen();
    feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
    await tick(20);
  }
  assert.equal(orchestrator.sends.length, 2);
  assert.equal(states(events).at(-1), 'idle');
  assert.equal(events.filter(e => e.type === 'log').length, 1);
  assert.equal(vc.speaking, false);
});

test('stt throws → state idle, log once, no send', async () => {
  const stt = { id: 'bad', label: 'Bad', async status() { return { ready: true }; }, async transcribe() { throw new Error('no recognizer'); } };
  const { events, orchestrator, vc } = setup({ stt });
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
  await tick(20);
  assert.equal(orchestrator.sends.length, 0);
  assert.equal(states(events).at(-1), 'idle');
  assert.equal(events.filter(e => e.type === 'log').length, 1);
});

test('cancel() while speaking stops tts and goes idle; while listening goes idle', async () => {
  const { events, vc, tts } = setup();
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
  await tick(20);
  assert.equal(vc.speaking, true);
  vc.cancel();
  await tick(5);
  assert.equal(tts.aborted, 1);
  assert.equal(vc.speaking, false);
  assert.equal(states(events).at(-1), 'idle');
  vc.listen();
  vc.cancel();
  assert.equal(states(events).at(-1), 'idle');
  assert.equal(vc.active, false);
});

test('wake heard while speaking (TTS saying "Jarvis") does not cut the reply', async () => {
  const bus = createBus();
  const events = [];
  bus.on('*', e => events.push(e));
  let onWake = null;
  const wake = { id: 'w', label: 'W', async status() { return { ready: true }; }, start(fn) { onWake = fn; }, stop() {} };
  const tts = fakeTts();
  const vc = createVoiceController({ bus, orchestrator: fakeOrchestrator('I am Jarvis.', bus), engines: { stt: fakeStt(), tts, wake }, getConfig: () => ({ ...DEFAULTS, wakeEnabled: true }), getSessionId: () => 's' });
  vc.applyWake();
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
  await tick(20);
  assert.equal(vc.speaking, true);
  onWake();
  await tick(5);
  assert.equal(vc.speaking, true);
  assert.equal(tts.aborted, 0);
});

test('spoken command while a text turn is busy is not dropped silently', async () => {
  const { events, orchestrator, vc } = setup();
  orchestrator.send = async () => { throw new Error('BUSY'); };
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
  await tick(20);
  const last = events.filter(e => e.type === 'state').at(-1);
  assert.equal(last.state, 'idle');
  assert.match(last.detail || '', /busy/i);
  assert.ok(events.some(e => e.type === 'log' && /what time is it/.test(e.text)));
});

test('feed while idle is ignored (no levels)', () => {
  const { events, vc } = setup();
  feedAll(vc, tone(200));
  assert.equal(events.length, 0);
});

test('engine registries ship None fallbacks that are not ready', async () => {
  const r = createEngineRegistries();
  for (const kind of ['stt', 'tts', 'wake']) {
    const none = r[kind].get('none');
    assert.ok(none, kind);
    assert.equal((await none.status()).ready, false);
  }
  await assert.rejects(r.stt.get('none').transcribe(new Int16Array(10), SR));
  assert.throws(() => r.tts.get('none').speak('x', {}));
});

test('wake engine: applyWake starts it when enabled; wake → event + listening', async () => {
  const bus = createBus();
  const events = [];
  bus.on('*', e => events.push(e));
  let onWake = null, stops = 0;
  const wake = { id: 'w', label: 'W', async status() { return { ready: true }; }, start(fn) { onWake = fn; }, stop() { stops++; onWake = null; } };
  let cfg = { ...DEFAULTS, wakeEnabled: true };
  const vc = createVoiceController({ bus, orchestrator: fakeOrchestrator(), engines: { stt: fakeStt(), tts: fakeTts(), wake }, getConfig: () => cfg, getSessionId: () => null });
  vc.applyWake();
  assert.equal(typeof onWake, 'function');
  onWake();
  assert.deepEqual(events.map(e => e.type), ['wake', 'state']);
  assert.equal(events[1].state, 'listening');
  cfg = { ...cfg, wakeEnabled: false };
  vc.applyWake();
  assert.equal(stops, 1);
});

// ---- streaming speech: speak sentence by sentence while the model is still writing ----
function streamingTts() {
  const t = { id: 'stream', label: 'S', pushes: [], ended: false, aborted: false, async status() { return { ready: true }; } };
  t.createStream = ({ signal }) => {
    let finish;
    const done = new Promise(r => { finish = r; });
    signal?.addEventListener('abort', () => { t.aborted = true; finish(); }, { once: true });
    async function* levels() { yield 0.5; }
    return { push: s => t.pushes.push({ s, at: Date.now() }), end: () => { t.ended = true; setTimeout(finish, 20); }, levels: levels(), done };
  };
  t.speak = () => { throw new Error('should stream'); };
  return t;
}
function streamingOrchestrator(bus, parts, gapMs = 15) {
  const o = { busy: false, stops: 0, sends: [], doneAt: 0 };
  o.stop = () => { o.stops++; o.stopped = true; };
  o.send = async (id, text, opts) => {
    o.sends.push(text); o.busy = true; o.stopped = false;
    bus.emit('state', { state: 'thinking' });
    let reply = '';
    for (const p of parts) {
      if (o.stopped) break;
      await new Promise(r => setTimeout(r, gapMs));
      reply += p; bus.emit('token', { text: p });
    }
    o.busy = false; o.doneAt = Date.now();
    return { reply, stopped: !!o.stopped, sessionId: 's' };
  };
  return o;
}

test('streaming: first sentence is spoken before the reply finishes; markdown is cleaned', async () => {
  const bus = createBus(); const events = []; bus.on('*', e => events.push(e));
  const tts = streamingTts();
  const orc = streamingOrchestrator(bus, ['The energy is **2.48 eV**.', ' That is green ', 'light.', ' Anything else?']);
  const vc = createVoiceController({ bus, orchestrator: orc, engines: { stt: fakeStt(), tts, wake: null }, getConfig: () => DEFAULTS, getSessionId: () => 's' });
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
  await tick(200);
  assert.deepEqual(tts.pushes.map(p => p.s), ['The energy is 2.48 electron volts.', 'That is green light.', 'Anything else?']);
  assert.ok(tts.pushes[0].at < orc.doneAt, 'speech started before the model finished');
  assert.equal(tts.ended, true);
  const st = states(events);
  assert.ok(st.indexOf('speaking') > st.indexOf('thinking'));
  assert.equal(st.at(-1), 'idle');
  assert.ok(events.some(e => e.type === 'level' && e.source === 'tts'));
});

test('streaming: talking over JARVIS stops the speech and the model', async () => {
  const bus = createBus();
  const tts = streamingTts();
  const orc = streamingOrchestrator(bus, ['First sentence here.', ' Second', ' part', ' keeps', ' going', ' on.'], 40);
  const vc = createVoiceController({ bus, orchestrator: orc, engines: { stt: fakeStt(), tts, wake: null }, getConfig: () => DEFAULTS, getSessionId: () => 's' });
  vc.listen();
  feedAll(vc, [...noise(300), ...tone(600), ...noise(900)]);
  await tick(90);
  assert.equal(vc.speaking, true);
  feedAll(vc, [...noise(300), ...tone(200, 0.4)]);
  await tick(20);
  assert.equal(tts.aborted, true);
  assert.ok(orc.stops >= 1, 'model stopped too');
  assert.equal(vc.mode, 'listening');
});

// ---- wake word with pre-roll: "Jarvis, what time is it" in one breath ----
function wakeSetup(sttText) {
  const bus = createBus(); const events = []; bus.on('*', e => events.push(e));
  let onWake = null;
  const wake = { id: 'w', label: 'W', async status() { return { ready: true }; }, start(fn) { onWake = fn; }, stop() {} };
  const stt = fakeStt(sttText);
  const orchestrator = fakeOrchestrator('It is noon.', bus);
  const vc = createVoiceController({ bus, orchestrator, engines: { stt, tts: fakeTts(), wake }, getConfig: () => ({ ...DEFAULTS, wakeEnabled: true }), getSessionId: () => 's' });
  vc.applyWake();
  return { bus, events, stt, orchestrator, vc, wake: () => onWake() };
}

test('wake: audio from just before the wake is kept, so a run-on command is transcribed whole', async () => {
  const w = wakeSetup('Jarvis, what time is it?');
  // idle: mic frames go to the ring buffer only (no levels, no VAD)
  feedAll(w.vc, [...noise(300), ...tone(1500)]);
  assert.equal(w.events.filter(e => e.type === 'level').length, 0);
  w.wake();
  feedAll(w.vc, noise(900));
  await tick(20);
  assert.ok(w.stt.calls[0].samples >= 16000 * 1.5, `pre-roll included: ${w.stt.calls[0].samples} samples`);
  assert.deepEqual(w.orchestrator.sends.map(s => s.text), ['what time is it?'], 'wake word stripped');
});

test('wake: only "Jarvis" said → keep listening for the command', async () => {
  const w = wakeSetup('Jarvis.');
  feedAll(w.vc, [...noise(300), ...tone(500)]);
  w.wake();
  feedAll(w.vc, noise(900));
  await tick(20);
  assert.equal(w.orchestrator.sends.length, 0);
  assert.equal(w.vc.mode, 'listening');
  assert.equal(states(w.events).at(-1), 'listening');
});

test('wake: ring buffer holds at most ~2.5 s', async () => {
  const w = wakeSetup('Jarvis, hi');
  feedAll(w.vc, [...noise(300), ...tone(6000)]);
  w.wake();
  feedAll(w.vc, noise(900));
  await tick(20);
  assert.ok(w.stt.calls[0].samples <= 16000 * (2.6 + 1.0), `${w.stt.calls[0].samples}`);
});

// ---- wake word heard by Whisper on the user's own mic (engine kind 'listen') ----
function listenWakeSetup(sttTexts) {
  const bus = createBus(); const events = []; bus.on('*', e => events.push(e));
  const queue = [...sttTexts];
  const stt = { id: 'w', label: 'W', calls: [], async status() { return { ready: true }; }, async transcribe(pcm) { this.calls.push(pcm.length); return queue.shift() ?? ''; } };
  const orchestrator = fakeOrchestrator('It is noon.', bus);
  const wake = { id: 'whisper', label: 'Whisper (your mic)', kind: 'listen', async status() { return { ready: true }; } };
  const vc = createVoiceController({ bus, orchestrator, engines: { stt, tts: fakeTts(), wake }, getConfig: () => ({ ...DEFAULTS, wakeEnabled: true }), getSessionId: () => 's' });
  vc.applyWake();
  return { bus, events, stt, orchestrator, vc };
}

test('listen-wake: "Jarvis, what time is it" while idle wakes and runs the command from the same audio', async () => {
  const w = listenWakeSetup(['Jarvis, what time is it?']);
  feedAll(w.vc, [...noise(300), ...tone(1200), ...noise(700)]);
  await tick(30);
  assert.ok(w.events.some(e => e.type === 'wake'));
  assert.deepEqual(w.orchestrator.sends.map(s => s.text), ['what time is it?']);
  assert.equal(w.stt.calls.length, 1, 'one transcription: wake + command together');
});

test('listen-wake: other speech while idle does nothing (no wake, no state change)', async () => {
  const w = listenWakeSetup(['so I told him about the game']);
  feedAll(w.vc, [...noise(300), ...tone(1200), ...noise(700)]);
  await tick(30);
  assert.equal(w.events.filter(e => e.type === 'wake' || e.type === 'state').length, 0);
  assert.equal(w.orchestrator.sends.length, 0);
  assert.equal(w.vc.mode, 'idle');
});

test('listen-wake: just "Jarvis" → chime-worthy wake, then listens for the command', async () => {
  const w = listenWakeSetup(['Jarvis.', 'open the chat']);
  feedAll(w.vc, [...noise(300), ...tone(600), ...noise(700)]);
  await tick(30);
  assert.ok(w.events.some(e => e.type === 'wake'));
  assert.equal(w.vc.mode, 'listening');
  feedAll(w.vc, [...noise(300), ...tone(800), ...noise(900)]);
  await tick(30);
  assert.deepEqual(w.orchestrator.sends.map(s => s.text), ['open the chat']);
});

test('listen-wake: idle detection is off when the wake word is disabled', async () => {
  const w = listenWakeSetup(['Jarvis, hi']);
  w.vc.applyWake.call(null);
  const vc2 = createVoiceController({ bus: w.bus, orchestrator: w.orchestrator, engines: { stt: w.stt, tts: fakeTts(), wake: { id: 'whisper', kind: 'listen' } }, getConfig: () => ({ ...DEFAULTS, wakeEnabled: false }), getSessionId: () => 's' });
  vc2.applyWake();
  feedAll(vc2, [...noise(300), ...tone(1200), ...noise(700)]);
  await tick(30);
  assert.equal(w.stt.calls.length, 0);
});
