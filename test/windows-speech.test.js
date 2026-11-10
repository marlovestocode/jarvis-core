const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSpeechHost, windowsTts, windowsStt, windowsWake, rateToSapi, wavBytes } = require('../src/core/voice/windows-speech');

// Fake child process: captures requests; tests answer by writing JSON lines to stdout.
function fakeSpawn() {
  const kids = [];
  const spawn = () => {
    const kid = new EventEmitter();
    kid.stdin = new PassThrough();
    kid.stdout = new PassThrough();
    kid.stderr = new PassThrough();
    kid.sent = [];
    let buf = '';
    kid.stdin.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { kid.sent.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    kid.reply = obj => kid.stdout.write(JSON.stringify(obj) + '\n');
    kid.kill = () => { kid.killed = true; kid.emit('exit', null); };
    kids.push(kid);
    return kid;
  };
  spawn.kids = kids;
  return spawn;
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

test('request resolves by id', async () => {
  const spawn = fakeSpawn();
  const host = createSpeechHost({ spawn });
  const p = host.request('ping', { a: 1 });
  await tick();
  const kid = spawn.kids[0];
  assert.deepEqual(kid.sent[0], { id: 1, cmd: 'ping', a: 1 });
  kid.reply({ id: 1, ok: true, result: 'pong' });
  assert.equal(await p, 'pong');
  const bad = host.request('boom');
  await tick();
  kid.reply({ id: 2, ok: false, error: 'nope' });
  await assert.rejects(bad, { message: 'nope' });
  host.close();
});

test('out-of-order replies matched', async () => {
  const spawn = fakeSpawn();
  const host = createSpeechHost({ spawn });
  const a = host.request('a'), b = host.request('b'), c = host.request('c');
  await tick();
  const kid = spawn.kids[0];
  // a partial line split across chunks must still parse
  kid.stdout.write('{"id":3,"ok":true,');
  kid.stdout.write('"result":"C"}\n');
  kid.reply({ id: 1, ok: true, result: 'A' });
  kid.reply({ id: 2, ok: true, result: 'B' });
  assert.deepEqual(await Promise.all([a, b, c]), ['A', 'B', 'C']);
  host.close();
});

test('crash → one restart, pending requests rejected', async () => {
  const spawn = fakeSpawn();
  const host = createSpeechHost({ spawn });
  const p = host.request('slow');
  await tick();
  spawn.kids[0].emit('exit', 1);
  await assert.rejects(p, /exited/);
  const q = host.request('again');
  await tick();
  assert.equal(spawn.kids.length, 2, 'restarted once');
  spawn.kids[1].reply({ id: 2, ok: true, result: 'ok' });
  assert.equal(await q, 'ok');
  spawn.kids[1].emit('exit', 1);
  await assert.rejects(host.request('dead'), /not running/);
  assert.equal(spawn.kids.length, 2, 'no second restart');
  host.close();
});

test('wake event reaches WakeEngine callback', async () => {
  const spawn = fakeSpawn();
  const host = createSpeechHost({ spawn });
  const wake = windowsWake(host);
  let woke = 0;
  wake.start(() => { woke++; });
  await tick();
  const kid = spawn.kids[0];
  assert.equal(kid.sent[0].cmd, 'wake-start');
  assert.equal(kid.sent[0].word, 'Jarvis');
  assert.equal(kid.sent[0].confidence, 0.7);
  kid.reply({ id: kid.sent[0].id, ok: true, result: true });
  kid.reply({ ev: 'wake', confidence: 0.91 });
  await tick();
  assert.equal(woke, 1);
  wake.stop();
  await tick();
  assert.equal(kid.sent.at(-1).cmd, 'wake-stop');
  kid.reply({ ev: 'wake' });
  await tick();
  assert.equal(woke, 1, 'no callback after stop');
  host.close();
});

test('tts: speak sends rate, word events drive levels, abort sends stop-speak', async () => {
  const spawn = fakeSpawn();
  const host = createSpeechHost({ spawn });
  const tts = windowsTts(host);
  const ac = new AbortController();
  const h = tts.speak('hello there', { rate: 2, signal: ac.signal });
  await tick();
  const kid = spawn.kids[0];
  const req = kid.sent[0];
  assert.deepEqual([req.cmd, req.text, req.rate], ['speak', 'hello there', 10]);
  const it = h.levels[Symbol.asyncIterator]();
  kid.reply({ ev: 'word', id: req.id });
  const first = await it.next();
  assert.ok(first.value >= 0.6, `level ${first.value}`);
  ac.abort();
  await tick();
  assert.equal(kid.sent.at(-1).cmd, 'stop-speak');
  kid.reply({ id: req.id, ok: true, result: { cancelled: true } });
  await h.done;
  host.close();
});

test('stt: writes a 16-bit mono WAV and returns the text', async () => {
  const spawn = fakeSpawn();
  const host = createSpeechHost({ spawn });
  const stt = windowsStt(host);
  const p = stt.transcribe(new Int16Array([0, 1000, -1000]), 16000);
  await tick(20);
  const kid = spawn.kids[0];
  assert.equal(kid.sent[0].cmd, 'transcribe');
  const fs = require('node:fs');
  const wav = fs.readFileSync(kid.sent[0].wav);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  kid.reply({ id: kid.sent[0].id, ok: true, result: 'what time is it' });
  assert.equal(await p, 'what time is it');
  assert.equal(fs.existsSync(kid.sent[0].wav), false, 'temp wav removed');
  host.close();
});

test('rateToSapi maps 0.5..2.0 to -10..10', () => {
  assert.equal(rateToSapi(1), 0);
  assert.equal(rateToSapi(2), 10);
  assert.equal(rateToSapi(0.5), -10);
  assert.equal(rateToSapi(9), 10);
  assert.equal(wavBytes(new Int16Array(4), 16000).length, 44 + 8);
});
