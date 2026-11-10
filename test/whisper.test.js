const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWhisperStt, cleanTranscript } = require('../src/core/voice/whisper');

function fakeSpawn() {
  const kids = [];
  const spawn = (exe, args) => {
    const k = new EventEmitter();
    k.exe = exe; k.args = args; k.stdout = new EventEmitter(); k.stderr = new EventEmitter();
    k.kill = () => { k.killed = true; k.emit('exit', null); };
    kids.push(k);
    return k;
  };
  spawn.kids = kids;
  return spawn;
}
const exists = () => true;

test('whisper: starts one server on 127.0.0.1 lazily, posts WAV, returns clean text', async () => {
  const spawn = fakeSpawn();
  const posts = [];
  let up = false;
  const fetch = async (url, opts = {}) => {
    if (!up) throw new Error('ECONNREFUSED');
    if (url.endsWith('/inference')) {
      posts.push(opts);
      return { ok: true, json: async () => ({ text: ' What time is it?\n' }) };
    }
    return { ok: true, text: async () => 'ok' };
  };
  const stt = createWhisperStt({ exe: 'C:/w/whisper-server.exe', model: 'C:/w/base.en.bin', port: 47810, spawn, fetch, exists, prompt: 'JARVIS, Ollama' });
  setTimeout(() => { up = true; }, 30);
  const text = await stt.transcribe(new Int16Array(16000), 16000);
  assert.equal(text, 'What time is it?');
  assert.equal(spawn.kids.length, 1);
  const a = spawn.kids[0].args;
  assert.ok(a.includes('--host') && a[a.indexOf('--host') + 1] === '127.0.0.1');
  assert.equal(a[a.indexOf('--port') + 1], '47810');
  assert.equal(a[a.indexOf('-m') + 1], 'C:/w/base.en.bin');
  const form = posts[0].body;
  assert.equal(form.get('response_format'), 'json');
  assert.equal(form.get('temperature'), '0');
  assert.equal(form.get('prompt'), 'JARVIS, Ollama');
  assert.equal((await form.get('file').arrayBuffer()).byteLength, 44 + 32000);
  await stt.transcribe(new Int16Array(160), 16000);
  assert.equal(spawn.kids.length, 1, 'server reused');
  stt.close();
  assert.equal(spawn.kids[0].killed, true);
});

test('whisper: not ready when files are missing; status ready when present', async () => {
  const none = createWhisperStt({ exe: 'x', model: 'y', spawn: fakeSpawn(), fetch: async () => ({ ok: true }), exists: () => false });
  assert.equal((await none.status()).ready, false);
  await assert.rejects(none.transcribe(new Int16Array(10), 16000), /not installed/);
  const ok = createWhisperStt({ exe: 'x', model: 'y', spawn: fakeSpawn(), fetch: async () => ({ ok: true }), exists });
  assert.equal((await ok.status()).ready, true);
});

test('whisper: server that never comes up → clear error, and a crash restarts it next time', async () => {
  const spawn = fakeSpawn();
  const stt = createWhisperStt({ exe: 'x', model: 'y', spawn, fetch: async () => { throw new Error('down'); }, exists, startTimeoutMs: 80 });
  await assert.rejects(stt.transcribe(new Int16Array(10), 16000), /did not start/);
  spawn.kids[0].emit('exit', 1);
  await assert.rejects(stt.transcribe(new Int16Array(10), 16000), /did not start/);
  assert.equal(spawn.kids.length, 2);
  stt.close();
});

test('cleanTranscript: drops whisper noise tags and blank results', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(music) Hello there. [Applause]'), 'Hello there.');
  assert.equal(cleanTranscript(' you'), '', 'one-word "you" is the classic silence hallucination');
  assert.equal(cleanTranscript(' Jarvis, play music.'), 'Jarvis, play music.');
});

test('whisper: speech longer than the window is split at a quiet point and joined', async () => {
  const spawn = fakeSpawn();
  const sizes = [];
  const fetch = async (url, opts = {}) => {
    if (url.endsWith('/inference')) {
      sizes.push((await opts.body.get('file').arrayBuffer()).byteLength - 44);
      return { ok: true, json: async () => ({ text: sizes.length === 1 ? ' First part.' : ' second part.' }) };
    }
    return { ok: true };
  };
  const stt = createWhisperStt({ exe: 'x', model: 'y', spawn, fetch, exists, maxChunkSec: 2 });
  // 3 s: loud, a quiet gap around 1.8 s, loud
  const pcm = new Int16Array(48000).map((_, i) => (i > 28000 && i < 30000 ? 0 : (i % 50) * 400 - 10000));
  const text = await stt.transcribe(pcm, 16000);
  assert.equal(text, 'First part. second part.');
  assert.equal(sizes.length, 2);
  assert.ok(sizes[0] / 2 > 28000 && sizes[0] / 2 < 30500, `cut at ${sizes[0] / 2}`);
  assert.equal(sizes[0] + sizes[1], 96000);
  assert.ok(spawn.kids[0].args.includes('-ac'));
  stt.close();
});
