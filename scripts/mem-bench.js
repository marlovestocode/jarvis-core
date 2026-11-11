// Memory benchmark for the long-lived parts of src/core. No dependencies: process.memoryUsage() after a forced GC.
//   node --expose-gc scripts/mem-bench.js [scenario ...]      (no names: all scenarios)
// Each scenario drives one component with fakes through a worst-case run and prints what stayed in memory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');

if (!global.gc) { console.error('run with: node --expose-gc scripts/mem-bench.js'); process.exit(1); }

const MB = n => Math.round(n / 1048576 * 100) / 100;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function retained() {
  for (let i = 0; i < 3; i++) { global.gc(); await tick(5); }
  const m = process.memoryUsage();
  return m.heapUsed + m.external;   // external includes ArrayBuffers
}
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-bench-${name}-`));
const dirBytes = d => fs.readdirSync(d).reduce((n, f) => n + fs.statSync(path.join(d, f)).size, 0);

function fakeKid() {
  const kid = new EventEmitter();
  kid.stdout = new EventEmitter(); kid.stderr = new EventEmitter();
  kid.stdin = Object.assign(new EventEmitter(), { write() { return true; } });
  kid.kill = () => {};
  return kid;
}

const scenarios = {
  // 300 different lookups of 200 KB each: what the fetcher keeps in memory and on disk
  async fetcher() {
    const { createFetcher } = require('../src/core/net/fetcher');
    const dir = tmp('fetch');
    const body = 'x'.repeat(200 * 1024);
    const fetcher = createFetcher({
      policy: { allowed: () => ({ ok: true, host: 'bench' }) }, cacheDir: dir,
      fetch: async url => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body + url }),
    });
    const before = await retained();
    for (let i = 0; i < 300; i++) await fetcher.getText('bench', `https://bench.test/q?i=${i}`, { ttlMs: 60000 });
    const out = { retainedMB: MB(await retained() - before), diskMB: MB(dirBytes(dir)), diskFiles: fs.readdirSync(dir).length };
    void fetcher;
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  },

  // a wallpaper client that stops reading its event stream while 60 MB of events are emitted
  async bridge() {
    const { createBus } = require('../src/core/bus');
    const { startBridge } = require('../src/core/bridge');
    const bus = createBus();
    const bridge = await startBridge({ bus, version: 'bench', ports: [47960, 47961, 47962] });
    const sock = net.connect(bridge.port, '127.0.0.1');
    await new Promise(r => sock.once('connect', r));
    sock.write(`GET /ai/stream HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\n\r\n`);
    sock.pause();   // never reads again
    await tick(100);
    const before = await retained();
    const text = 'y'.repeat(300);
    for (let i = 0; i < 200000; i++) { bus.emit('token', { text }); if (i % 5000 === 0) await tick(); }
    await tick(100);
    const out = { retainedMB: MB(await retained() - before), clientsLeft: bridge.clients() };
    sock.destroy();
    await bridge.close();
    return out;
  },

  // a host process that never answers: 20,000 requests whose callers gave up after their own timeout
  async host() {
    const { createSpeechHost } = require('../src/core/voice/windows-speech');
    const host = createSpeechHost({ spawn: () => fakeKid(), script: 'x' });
    const before = await retained();
    for (let i = 0; i < 20000; i++) host.request('state', {}, { timeoutMs: 1 }).catch(() => {});
    await tick(200);
    const out = { retainedMB: MB(await retained() - before) };
    host.close();
    return out;
  },

  // 20,000 chats, each one turn with skill groups: what the orchestrator keeps per session
  async orchestrator() {
    const { createBus } = require('../src/core/bus');
    const { createOrchestrator } = require('../src/core/orchestrator');
    const { createSessionStore } = require('../src/core/session');
    const real = createSessionStore(tmp('orch'));
    const sessions = { create: real.create, load: () => null, save() {} };
    const provider = { id: 'p', label: 'P', capabilities: { tools: true }, async status() { return { ready: true }; }, async *chat() { yield { type: 'token', text: 'ok' }; yield { type: 'done', usage: {} }; } };
    const scope = { specs: () => [{ name: 't', description: '', params: {} }], run: async () => ({ ok: true, text: '' }), loaded: () => ['core', 'media', 'knowledge'], hints: () => [] };
    const orch = createOrchestrator({ bus: createBus(), sessions, providers: { get: () => provider }, tools: { turn: () => scope, specs: scope.specs }, getConfig: () => ({ provider: 'p' }), selectGroups: () => ['core'] });
    const before = await retained();
    for (let i = 0; i < 20000; i++) await orch.send(null, 'hi');
    const out = { retainedMB: MB(await retained() - before) };
    void orch;
    return out;
  },

  // speech-to-text hangs after a capture while the mic keeps sending 20 minutes of frames
  async voice() {
    const { createBus } = require('../src/core/bus');
    const { createVoiceController } = require('../src/core/voice/controller');
    const { DEFAULTS } = require('../src/core/config');
    const { noise, tone } = require('../test/helpers/pcm');
    const stt = { id: 's', label: 'S', transcribe: () => new Promise(() => {}) };
    const vc = createVoiceController({
      bus: createBus(), orchestrator: { busy: false, stop() {}, send: async () => ({ reply: '', sessionId: 's' }) },
      engines: { stt, tts: null, wake: null }, getConfig: () => ({ ...DEFAULTS, continuationGuard: true }), getSessionId: () => 's',
    });
    vc.listen();
    for (const f of [...noise(300), ...tone(800), ...noise(1200)]) vc.feed(f, 16000);
    const before = await retained();
    for (let i = 0; i < 20 * 60 * 50; i++) vc.feed(new Int16Array(320), 16000);
    const out = { mode: vc.mode, retainedMB: MB(await retained() - before) };
    void vc;
    return out;
  },

  // Silero inference hangs while a capture pushes 10 minutes of audio
  async silero() {
    const { createSileroStream } = require('../src/core/voice/silero');
    class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
    let errors = 0;
    const hung = [];   // held like the native runtime holds its callbacks, so the waiting frames stay reachable
    const model = { ort: { Tensor }, names: { input: 'input', state: 'state', sr: 'sr', output: 'output', stateN: 'stateN' }, run: () => new Promise(r => hung.push(r)) };
    const stream = createSileroStream(model, { onError: () => { errors++; } });
    const before = await retained();
    for (let i = 0; i < 10 * 60 * 50; i++) stream.push(new Int16Array(320), 16000);
    await tick(50);
    const out = { retainedMB: MB(await retained() - before), errors };
    void stream; void hung;
    return out;
  },

  // 50 replies of 6 sentences, each cut after the first sentence: WAV files left in the temp folder
  async piper() {
    const { createPiperTts } = require('../src/core/voice/piper');
    const made = new Set();
    let n = 0;
    const spawn = () => {
      const kid = fakeKid();
      kid.stdin.write = () => { const p = `out-${n++}.wav`; made.add(p); setTimeout(() => kid.stdout.emit('data', p + '\n'), 1); return true; };
      return kid;
    };
    const piper = createPiperTts({
      exe: 'x', model: 'y', outDir: tmp('piper'), spawn, exists: () => true, readFile: () => Buffer.alloc(44 + 320000), remove: p => made.delete(p),
      play: (pcm, rate, { signal }) => new Promise(res => signal.addEventListener('abort', res, { once: true })),
    });
    for (let i = 0; i < 50; i++) {
      const ac = new AbortController();
      const s = piper.createStream({ signal: ac.signal });
      for (let k = 0; k < 6; k++) s.push(`Sentence ${k}.`);
      s.end();
      await tick(10);
      ac.abort();
      await s.done.catch(() => {});
    }
    await tick(50);
    return { wavFilesLeft: made.size, diskMBLeft: MB(made.size * (44 + 320000)) };
  },

  // one chat that is never cleared: cost of a turn and of listing chats as the history grows
  async session() {
    const { createBus } = require('../src/core/bus');
    const { createOrchestrator } = require('../src/core/orchestrator');
    const { createSessionStore } = require('../src/core/session');
    const dir = tmp('session');
    const sessions = createSessionStore(dir);
    const provider = { id: 'p', label: 'P', capabilities: {}, async status() { return { ready: true, contextMax: 8192 }; }, async *chat() { yield { type: 'token', text: 'ok' }; yield { type: 'done', usage: {} }; } };
    const orch = createOrchestrator({ bus: createBus(), sessions, providers: { get: () => provider }, getConfig: () => ({ provider: 'p' }) });
    const out = {};
    for (const count of [200, 2000, 20000]) {
      const s = sessions.create();
      for (let i = 0; i < count; i++) s.messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'm'.repeat(400) });
      sessions.save(s);
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) await orch.send(s.id, 'next');
      out[`msPerTurn_${count}msgs`] = Math.round((performance.now() - t0) / 10 * 10) / 10;
    }
    const t1 = performance.now();
    sessions.list();
    out.listMs = Math.round(performance.now() - t1);
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  },

  // the PC action log over a long life: 20,000 actions (MB_ACTIONLOG=<file> runs another copy of the module, for before/after)
  async actionlog() {
    const { createActionLog } = require(process.env.MB_ACTIONLOG || '../src/core/pc/actions-log');
    const dir = tmp('actions');
    const file = path.join(dir, 'actions.log');
    const before = await retained();
    const log = createActionLog({ file });
    log.write({ what: 'recycle', args: { path: 'C:/x' }, result: 'ok', ok: true, undo: [{ from: 'a', to: 'b' }] });
    for (let i = 0; i < 20000; i++) log.write({ what: 'focus', args: { name: 'Some App ' + i }, result: 'Brought Some App to the front.', ok: true });
    const t0 = performance.now();
    const again = createActionLog({ file });   // a restart reads the file whole
    const out = { entries: log.list().length, fileKB: Math.round(fs.statSync(file).size / 1024), restartMs: Math.round(performance.now() - t0), undoable: !!again.lastUndoable(), retainedMB: MB(await retained() - before) };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  },

  // 100,000 logged plays: what the listening log keeps in memory for the whole run
  async playlog() {
    const { createPlayLog } = require('../src/core/music/log');
    const dir = tmp('plays');
    const log = createPlayLog({ file: path.join(dir, 'plays.jsonl') });
    const before = await retained();
    const t0 = Date.now() - 100000 * 200000;
    for (let i = 0; i < 100000; i++) log.add({ videoId: 'vid' + String(i % 5000).padStart(6, '0'), startedAt: t0 + i * 200000, listenedMs: 180000, duration: 200, title: 'Some Song Title ' + (i % 5000), artist: 'Artist ' + (i % 300), album: 'Album', reason: 'ended' });
    const out = { retainedMB: MB(await retained() - before), plays: log.count() };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  },
};

(async () => {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(scenarios);
  const results = {};
  for (const name of names) {
    if (!scenarios[name]) { console.error('unknown scenario: ' + name); continue; }
    results[name] = await scenarios[name]();
    console.log(name.padEnd(13), JSON.stringify(results[name]));
  }
  process.exit(0);
})();
