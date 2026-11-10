const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrace } = require('../src/core/voice/trace');
const { createBus } = require('../src/core/bus');
const { createVoiceController } = require('../src/core/voice/controller');
const { DEFAULTS } = require('../src/core/config');
const { SR, noise, tone } = require('./helpers/pcm');

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

test('trace: marks are offsets from the first mark, first occurrence wins', () => {
  let t = 1000;
  const tr = createTrace({ now: () => t });
  tr.mark('speech_start'); t = 1500;
  tr.mark('speech_end'); t = 1600;
  tr.mark('stt_done'); t = 1650;
  tr.mark('first_token'); t = 1900;
  tr.mark('first_audio'); t = 2000;
  tr.mark('first_audio'); // ignored: already marked
  tr.mark('turn_end');
  const s = tr.summary();
  assert.deepEqual(s.marks, { speech_start: 0, speech_end: 500, stt_done: 600, first_token: 650, first_audio: 900, turn_end: 1000 });
  assert.equal(s.speech_end_to_stt, 100);
  assert.equal(s.stt_to_first_token, 50);
  assert.equal(s.speech_end_to_first_audio, 400);
  assert.equal(s.total, 1000);
});

test('trace: missing marks give null deltas; reset clears', () => {
  let t = 0;
  const tr = createTrace({ now: () => t });
  tr.mark('wake_heard'); t = 40; tr.mark('stt_done');
  const s = tr.summary();
  assert.equal(s.speech_end_to_first_audio, null);
  assert.equal(s.speech_end_to_stt, null);
  tr.reset();
  assert.deepEqual(tr.summary().marks, {});
  assert.equal(tr.summary().total, null);
});

function rig(extra = {}) {
  const bus = createBus();
  const events = [];
  bus.on('*', e => events.push(e));
  const orchestrator = { busy: false, stop() {}, async send() { bus.emit('token', { text: 'It is noon. ' }); return { reply: 'It is noon.', sessionId: 's' }; } };
  const stt = { id: 'f', async status() { return { ready: true }; }, async transcribe() { return 'what time is it'; } };
  const tts = { id: 'f', async status() { return { ready: true }; }, speak(text, { signal }) {
    let resolve; const done = new Promise(r => { resolve = r; });
    tts.finish = resolve; signal?.addEventListener('abort', () => resolve(), { once: true });
    return { done };
  } };
  const traces = [];
  const vc = createVoiceController({ bus, orchestrator, engines: { stt, tts, wake: null },
    getConfig: () => ({ ...DEFAULTS }), getSessionId: () => 's', writeTrace: s => traces.push(s), ...extra });
  return { vc, events, tts, traces };
}

test('controller: a turn emits a voice-timing debug log and writes one trace line', async () => {
  const { vc, events, tts, traces } = rig();
  vc.listen();
  for (const f of [...noise(300), ...tone(1000), ...noise(900)]) vc.feed(f, SR);
  await tick(20);
  tts.finish();
  await tick(10);
  const log = events.find(e => e.type === 'log' && e.level === 'debug' && e.text.startsWith('voice-timing '));
  assert.ok(log, 'voice-timing log emitted');
  assert.equal(traces.length, 1);
  const m = traces[0].marks;
  for (const k of ['speech_start', 'speech_end', 'stt_done', 'first_token', 'first_audio', 'turn_end']) assert.ok(k in m, k);
  assert.ok(m.speech_start <= m.speech_end && m.speech_end <= m.stt_done && m.stt_done <= m.first_audio && m.first_audio <= m.turn_end);
  assert.deepEqual(JSON.parse(log.text.slice('voice-timing '.length)).marks, m);
});

test('controller: a throwing writeTrace never breaks the turn', async () => {
  const { vc, events, tts } = rig({ writeTrace: () => { throw new Error('disk full'); } });
  vc.listen();
  for (const f of [...noise(300), ...tone(1000), ...noise(900)]) vc.feed(f, SR);
  await tick(20);
  tts.finish();
  await tick(10);
  assert.equal(events.filter(e => e.type === 'state').at(-1).state, 'idle');
});
