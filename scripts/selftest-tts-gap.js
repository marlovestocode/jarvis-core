// Phase 5: gap between spoken sentences (play end → next play start) with real Piper streaming.
// Sentences arrive at the chat model's measured speed (~48 tokens/s ≈ 190 chars/s); play() waits for the
// clip's real duration, standing in for ctx.mic.play (the renderer's own start-up cost is not included).
//   node scripts/selftest-tts-gap.js
const path = require('node:path');
const os = require('node:os');
const { createPiperTts } = require('../src/core/voice/piper');
const M = require('./lib/voice-metrics');

const ENG = path.join(__dirname, '..', 'engines');
const CHARS_PER_S = 190;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPLIES = [
  ['It is sunny and 75 degrees right now.', ' Tomorrow looks warmer, with a high near 82.', ' Rain is unlikely until the weekend.', ' Winds stay light from the south.'],
  ['Your GPU is at 37 degrees and almost idle.', ' The CPU is at 15 percent.', ' Memory use is high, at 85 percent.', ' Chrome is using the most of it.'],
  ['Playing Antarctica by Suicideboys.', ' After that comes Matte Black.', ' The queue has five more songs.'],
  ['The Treaty of Westphalia was signed in 1648.', ' It ended the Thirty Years War.', ' It is often seen as the start of the modern state system.', ' Two cities hosted the talks.'],
  ['Sure.', ' I set a reminder for tomorrow at nine.', ' I will also remind you an hour before.'],
];

(async () => {
  const marks = [];
  const piper = createPiperTts({
    exe: path.join(ENG, 'piper', 'bin', 'piper', 'piper.exe'), model: path.join(ENG, 'piper', 'en_GB-alan-medium.onnx'),
    outDir: path.join(os.tmpdir(), 'jarvis-gap'),
    play: async (pcm, rate) => { marks.push({ start: performance.now() }); await sleep(pcm.length / rate * 1000); marks.at(-1).end = performance.now(); },
  });
  piper.warm(1);
  await sleep(1500);
  const gaps = [], firstAudio = [];
  for (const sentences of REPLIES) {
    marks.length = 0;
    const s = piper.createStream({ rate: 1 });
    const t0 = performance.now();
    for (const text of sentences) { await sleep(text.length / CHARS_PER_S * 1000); s.push(text); }
    s.end();
    await s.done;
    firstAudio.push(Math.round(marks[0].start - t0));
    for (let i = 1; i < marks.length; i++) gaps.push(Math.round(marks[i].start - marks[i - 1].end));
  }
  piper.close?.();
  console.log(JSON.stringify({ sentences: gaps.length, gapP50: M.percentile(gaps, 50), gapP95: M.percentile(gaps, 95), gapMax: Math.max(...gaps), gaps, firstSentenceAudioMs: firstAudio }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
