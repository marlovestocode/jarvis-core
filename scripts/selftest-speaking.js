// Real-engine self-test for the speaking safeguards (spec §7a), not part of npm test.
// Piper speaks test phrases into memory, Whisper transcribes them as mic input while a fake reply
// is "speaking". Expect: other talk and JARVIS's own echo ignored; "Jarvis, stop" stops at once;
// "Jarvis, <question>" finishes the sentence and runs the question.
//   node scripts/selftest-speaking.js
const path = require('node:path');
const os = require('node:os');
const { createBus } = require('../src/core/bus');
const { createVoiceController } = require('../src/core/voice/controller');
const { createWhisperStt } = require('../src/core/voice/whisper');
const { createPiperTts } = require('../src/core/voice/piper');
const { DEFAULTS } = require('../src/core/config');

const ENG = path.join(__dirname, '..', 'engines');
const SR = 16000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function say(text) {
  const parts = [];
  const piper = createPiperTts({
    exe: path.join(ENG, 'piper', 'bin', 'piper', 'piper.exe'), model: path.join(ENG, 'piper', 'en_GB-alan-medium.onnx'),
    outDir: path.join(os.tmpdir(), 'jarvis-selftest'), play: async pcm => { parts.push(pcm); },
  });
  await piper.speak(text, { rate: 1 }).done;
  piper.close();
  const src = Int16Array.from(parts.flatMap(p => Array.from(p)));
  const n = Math.floor(src.length * SR / 22050);         // 22.05 kHz → 16 kHz, linear
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) { const x = i * 22050 / SR, j = Math.floor(x), f = x - j; out[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; }
  return out;
}
const silence = ms => new Int16Array(Math.round(SR * ms / 1000)).map(() => (Math.random() - 0.5) * 120);
function feed(vc, pcm) { for (let i = 0; i < pcm.length; i += 320) vc.feed(pcm.subarray(i, i + 320), SR); }

async function scenario(name, utter, reply) {
  const bus = createBus();
  const log = [];
  bus.on('*', e => { if (e.type === 'state' || e.type === 'wake' || e.type === 'log') log.push(e.type + ':' + (e.state || e.text || '')); });
  const tts = { id: 't', label: 't', aborted: false, finished: false, async status() { return { ready: true }; } };
  tts.createStream = ({ signal }) => {
    let resolve; const done = new Promise(r => { resolve = r; });
    signal?.addEventListener('abort', () => { tts.aborted = true; resolve(); }, { once: true });
    return { push() {}, end() {}, finishSentence: () => { tts.finished = true; setTimeout(resolve, 50); return done; }, levels: [], done };
  };
  const sends = [];
  const orc = { busy: false, stop() {}, async send(id, text) { sends.push(text); if (sends.length === 1) bus.emit('token', { text: reply + ' And more.' }); return { reply, stopped: false, sessionId: 's' }; } };
  const vc = createVoiceController({ bus, orchestrator: orc, engines: { stt: whisper, tts, wake: null }, getConfig: () => DEFAULTS, getSessionId: () => 's' });
  vc.listen();
  feed(vc, silence(400)); feed(vc, await say('What is the weather?')); feed(vc, silence(1200));
  for (let i = 0; i < 100 && !vc.speaking; i++) await sleep(50);
  if (!vc.speaking) return { name, ok: false, why: 'never started speaking', log, sends };
  feed(vc, silence(400)); feed(vc, await say(utter)); feed(vc, silence(900));
  await sleep(2500);
  return { name, vc: vc.mode, aborted: tts.aborted, finished: tts.finished, sends, log };
}

const whisper = createWhisperStt({
  exe: path.join(ENG, 'whisper', 'bin', 'Release', 'whisper-server.exe'), model: path.join(ENG, 'whisper', 'ggml-base.en.bin'), port: 47815,
  prompt: 'JARVIS',
});

(async () => {
  const reply = 'It is sunny and warm today.';
  const results = [
    await scenario('other talk', 'So I was telling my friend about the game last night.', reply),
    await scenario('echo', reply, reply),
    await scenario('Jarvis stop', 'Jarvis, stop.', reply),
    await scenario('Jarvis new question', 'Jarvis, what about tomorrow?', reply),
  ];
  whisper.close?.();
  const expect = {
    'other talk': r => !r.aborted && !r.finished && r.sends.length === 1 && r.vc === 'speaking',
    'echo': r => !r.aborted && !r.finished && r.sends.length === 1 && r.vc === 'speaking',
    'Jarvis stop': r => r.aborted && !r.finished && r.sends.length === 1 && r.vc === 'idle',
    'Jarvis new question': r => !r.aborted && r.finished && r.sends.length === 2 && /tomorrow/i.test(r.sends[1]),
  };
  let bad = 0;
  for (const r of results) { const ok = expect[r.name](r); if (!ok) bad++; console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(r)); }
  process.exit(bad ? 1 : 0);
})();
