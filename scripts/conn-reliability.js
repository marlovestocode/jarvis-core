// Connection reliability under faults, no network and no GPU: the same scenarios against any copy of src/ (default: this one).
//   node scripts/conn-reliability.js [path-to-a-jarvis-core-checkout]      e.g. a `git archive` of an older commit
// 1. a helper process (speech/media/PC host) that crashes now and then over a long run: how many crashes does it survive?
// 2. the local model server refusing connections for a moment (a restart): how many of 100 chat requests still get an answer?
// 3. a request in flight when the browser extension reconnects on a new socket: how long until the caller is told?
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('node:net');
const crypto = require('node:crypto');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const need = p => require(path.join(root, p));
const tick = ms => new Promise(r => setTimeout(r, ms));

function fakeSpawn() {
  const kids = [];
  const spawn = () => { const k = new EventEmitter(); k.stdin = new PassThrough(); k.stdout = new PassThrough(); k.stderr = new PassThrough(); k.kill = () => {}; kids.push(k); return k; };
  spawn.kids = kids; return spawn;
}

async function hostCrashes() {
  const { createSpeechHost } = need('src/core/voice/windows-speech');
  let t = 0;
  const spawn = fakeSpawn();
  const host = createSpeechHost({ spawn, script: 'x', now: () => t });   // an older copy ignores `now`: it has no clock to use
  host.request('a').catch(() => {});
  let survived = 0;
  for (let i = 0; i < 20; i++) {
    t += 10 * 60 * 1000;                      // each helper ran ten minutes before it died
    const before = spawn.kids.length;
    spawn.kids.at(-1).emit('exit', 1);
    if (spawn.kids.length > before) survived++; else break;
  }
  host.close();
  return { crashesSurvived: survived, of: 20 };
}

async function modelRefusals() {
  const { createOllamaProvider } = need('src/core/providers/ollama');
  const TAGS = { models: [{ name: 'm', capabilities: ['completion'], details: {} }] };
  const enc = new TextEncoder();
  const ok = () => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(enc.encode(JSON.stringify({ message: { content: 'hi' }, done: true }) + '\n')); c.close(); } }) });
  let answered = 0, seed = 42;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 100; i++) {
    let refusals = Math.floor(rnd() * 3);       // 0, 1 or 2 refused connections in a row (a restart takes a moment)
    const fetchImpl = async url => {
      const p = new URL(url).pathname;
      if (p === '/api/tags') return { ok: true, status: 200, json: async () => TAGS };
      if (p === '/api/show') return { ok: true, status: 200, json: async () => ({}) };
      if (refusals-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return ok();
    };
    const p = createOllamaProvider({ getConfig: () => ({ ollama: { host: 'http://127.0.0.1:11434', model: 'm' } }), fetch: fetchImpl, retryBaseMs: 1 });
    try { for await (const c of p.chat({ messages: [{ role: 'user', content: 'x' }] })) if (c.type === 'done') { answered++; break; } } catch { /* the turn failed */ }
  }
  return { answered, of: 100 };
}

async function replacedSocket() {
  const { startYtMusicLink, frame } = need('src/core/media/ytmusic-link');
  const { EXTENSION_ID } = need('src/core/media/ytmusic-id');
  const link = startYtMusicLink({ ports: [47910, 47911], timeoutMs: 5000 });
  const port = await link.started;
  const connect = () => new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('error', reject);
    s.write(`GET /ytmusic HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: chrome-extension://${EXTENSION_ID}\r\n\r\n`);
    s.once('data', () => resolve(s));
  });
  void frame;
  const a = await connect(); await tick(30);
  const p = link.request('status'); p.catch(() => {});
  await tick(30);
  const t0 = Date.now();
  const b = await connect();
  const told = await Promise.race([p.then(() => 'answered', () => 'failed'), tick(6000).then(() => 'never')]);
  const ms = Date.now() - t0;
  a.destroy(); b.destroy(); await link.close();
  return { callerToldAfterMs: told === 'never' ? '>6000 (timeout)' : ms };
}

(async () => {
  const out = { copy: root };
  out.hostCrashes = await hostCrashes();
  out.modelRefusals = await modelRefusals();
  out.replacedSocket = await replacedSocket();
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
