const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createPiperTts } = require('../src/core/voice/piper');

// Fake piper: one wav path per stdin line, after a short delay.
function fakeSpawn() {
  const kids = [];
  const spawn = (exe, args) => {
    const k = new EventEmitter();
    k.args = args; k.stdin = new PassThrough(); k.stdout = new PassThrough(); k.stderr = new PassThrough(); k.lines = [];
    let buf = '';
    k.stdin.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        k.lines.push(line);
        const n = k.lines.length;
        setTimeout(() => k.stdout.write(`C:\\out\\${n}.wav\n`), 5);
      }
    });
    k.kill = () => { k.killed = true; k.emit('exit', null); };
    kids.push(k);
    return k;
  };
  spawn.kids = kids;
  return spawn;
}
// 0.1 s of loud audio as a WAV
const wav = () => { const pcm = new Int16Array(2205).fill(12000); const h = Buffer.alloc(44); h.write('RIFF', 0); return Buffer.concat([h, Buffer.from(pcm.buffer)]); };

function setup() {
  const spawn = fakeSpawn();
  const played = [];
  const removed = [];
  const play = (pcm, rate, { signal, onLevel } = {}) => {
    played.push({ samples: pcm.length, rate });
    onLevel?.(0.4);
    return new Promise((res, rej) => {
      const t = setTimeout(res, 10);
      signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
  };
  const tts = createPiperTts({ exe: 'piper.exe', model: 'alan.onnx', outDir: 'C:/out', spawn, play, exists: () => true,
    readFile: () => wav(), remove: p => removed.push(p), sampleRate: 22050 });
  return { tts, spawn, played, removed };
}

test('piper stream: sentences are synthesized in order and played one after another', async () => {
  const { tts, spawn, played, removed } = setup();
  const s = tts.createStream({ rate: 1 });
  s.push('Good evening.');
  s.push('All systems online.');
  s.end();
  const levels = [];
  for await (const v of s.levels) levels.push(v);
  await s.done;
  assert.deepEqual(spawn.kids[0].lines, ['Good evening.', 'All systems online.']);
  assert.equal(played.length, 2);
  assert.equal(played[0].rate, 22050);
  assert.equal(played[0].samples, 2205);
  assert.ok(levels.includes(0.4));
  assert.deepEqual(removed, ['C:\\out\\1.wav', 'C:\\out\\2.wav']);
  assert.ok(spawn.kids[0].args.includes('--output_dir'));
});

test('piper: one process is reused; a new voice rate restarts it with a new length scale', async () => {
  const { tts, spawn } = setup();
  await tts.speak('One.', { rate: 1 }).done;
  await tts.speak('Two.', { rate: 1 }).done;
  assert.equal(spawn.kids.length, 1);
  await tts.speak('Three.', { rate: 2 }).done;
  assert.equal(spawn.kids.length, 2);
  const a = spawn.kids[1].args;
  assert.equal(a[a.indexOf('--length_scale') + 1], '0.5');
});

test('piper: abort stops playback and drops queued sentences', async () => {
  const { tts, played } = setup();
  const ac = new AbortController();
  const s = tts.createStream({ rate: 1, signal: ac.signal });
  s.push('First sentence.'); s.push('Second.'); s.push('Third.');
  setTimeout(() => ac.abort(), 8);
  s.end();
  await s.done;
  assert.ok(played.length <= 1, `played ${played.length}`);
});

test('piper: text is one line (newlines would split it); empty text is skipped', async () => {
  const { tts, spawn, played } = setup();
  const s = tts.createStream({ rate: 1 });
  s.push('Line one\nline two'); s.push('   ');
  s.end();
  await s.done;
  assert.deepEqual(spawn.kids[0].lines, ['Line one line two']);
  assert.equal(played.length, 1);
});

test('piper: status reports missing files', async () => {
  const t = createPiperTts({ exe: 'x', model: 'y', outDir: 'z', exists: () => false, play: async () => {} });
  assert.equal((await t.status()).ready, false);
});
