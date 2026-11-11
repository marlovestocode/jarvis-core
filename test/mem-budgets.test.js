// Memory budgets: every long-lived part of the core that could grow without limit has a cap, and reports it.
// Measured before and after with scripts/mem-bench.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createBus } = require('../src/core/bus');
const { createFetcher } = require('../src/core/net/fetcher');
const { startBridge } = require('../src/core/bridge');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createVoiceController } = require('../src/core/voice/controller');
const { createSileroStream } = require('../src/core/voice/silero');
const { createSpeechHost, windowsTts, windowsStt, windowsWake } = require('../src/core/voice/windows-speech');
const { createPcHost, LIMIT_MS, SCRIPT: PC_HOST_SCRIPT } = require('../src/core/pc/host');
const { createMediaService } = require('../src/core/media/service');
const { startYtMusicLink, frame } = require('../src/core/media/ytmusic-link');
const { createActionLog } = require('../src/core/pc/actions-log');
const { createMemWatch } = require('../src/core/memwatch');
const { selfChecks } = require('../src/main/checks');
const { DEFAULTS } = require('../src/core/config');
const { noise, tone } = require('./helpers/pcm');

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-mem-'));
const sha = url => crypto.createHash('sha1').update(url).digest('hex') + '.json';
const DAY = 24 * 3600 * 1000;

// ---- fetcher ----
function fetcherSetup(opts = {}) {
  const calls = [];
  const fetch = async url => { calls.push(url); return new Response(url.slice(-1).repeat(400), { status: 200 }); };
  const cacheDir = opts.cacheDir === undefined ? tmp() : opts.cacheDir;
  const fetcher = createFetcher({ policy: { allowed: () => ({ ok: true, host: 'h' }) }, fetch, ...opts, cacheDir });
  return { fetcher, calls, cacheDir };
}
const U = c => `https://h.test/${c}`;

test('fetcher: the memory cache keeps to its budget and drops the least recently used entry', async () => {
  const { fetcher, calls } = fetcherSetup({ memMaxChars: 1000 });
  await fetcher.getText('s', U('a'), { ttlMs: 60000 });
  await fetcher.getText('s', U('b'), { ttlMs: 60000 });
  await fetcher.getText('s', U('a'), { ttlMs: 60000 });   // a is now the most recent
  await fetcher.getText('s', U('c'), { ttlMs: 60000 });   // 1200 chars: b goes
  assert.deepEqual(fetcher.stats(), { entries: 2, chars: 800, capChars: 1000, evicted: 1 });
  // the dropped entry still answers from the disk cache, without the network
  const r = await fetcher.getText('s', U('b'), { ttlMs: 60000 });
  assert.equal(r.cached, true);
  assert.equal(r.data, 'b'.repeat(400));
  assert.equal(calls.length, 3);
  assert.ok(fetcher.stats().chars <= 1000);
});

test('fetcher: an answer larger than the whole budget is kept on disk only', async () => {
  const { fetcher } = fetcherSetup({ memMaxChars: 300 });
  await fetcher.getText('s', U('a'), { ttlMs: 60000 });
  assert.equal(fetcher.stats().entries, 0);
  assert.equal((await fetcher.getText('s', U('a'), { ttlMs: 60000 })).cached, true);
});

test('fetcher: trim() empties the memory cache; the disk copy still gives "last known"', async () => {
  const { fetcher } = fetcherSetup();
  await fetcher.getText('s', U('a'), { ttlMs: 60000 });
  fetcher.trim();
  assert.deepEqual({ entries: fetcher.stats().entries, chars: fetcher.stats().chars }, { entries: 0, chars: 0 });
  assert.equal((await fetcher.getText('s', U('a'), { ttlMs: 60000 })).cached, true);
});

test('fetcher: the disk cache drops files too old to serve and the oldest over its size cap, and only its own files', async () => {
  const cacheDir = tmp();
  const put = (name, ageMs, bytes = 1000) => { const p = path.join(cacheDir, name); fs.writeFileSync(p, 'x'.repeat(bytes)); const t = new Date(Date.now() - ageMs); fs.utimesSync(p, t, t); };
  put(sha('old'), 8 * DAY);
  put(sha('big-older'), 3 * DAY);
  put(sha('big-newer'), 2 * DAY);
  put('ytm-library.json', 30 * DAY);            // another module's file in the same folder
  fs.mkdirSync(path.join(cacheDir, 'Cache_Data'));   // Chromium's own cache shares this folder on Windows
  const { fetcher } = fetcherSetup({ cacheDir, diskMaxBytes: 1600 });
  await fetcher.getText('s', U('a'), { ttlMs: 60000 });   // writes about 450 bytes, then prunes
  const left = fs.readdirSync(cacheDir).sort();
  assert.deepEqual(left, ['Cache_Data', sha(U('a')), sha('big-newer'), 'ytm-library.json'].sort());
});

// ---- bridge ----
test('bridge: a client that stops reading is dropped, not buffered without limit', async () => {
  const bus = createBus();
  const free = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const bridge = await startBridge({ bus, version: 't', ports: [free], clientMaxBuffer: 64 * 1024 });
  const port = bridge.port;
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.once('connect', r));
  sock.write(`GET /ai/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  sock.pause();
  await tick(50);
  assert.equal(bridge.clients(), 1);
  const text = 'y'.repeat(1000);
  for (let i = 0; i < 40000 && bridge.clients(); i++) { bus.emit('token', { text }); if (i % 500 === 0) await tick(1); }
  assert.equal(bridge.clients(), 0);
  assert.deepEqual(bridge.stats(), { clients: 0, dropped: 1, capBytes: 64 * 1024 });
  sock.destroy();
  await bridge.close();
});

// ---- orchestrator ----
test('orchestrator: the per-session skill-group memory is capped', async () => {
  const provider = { id: 'p', label: 'P', capabilities: { tools: true }, async status() { return { ready: true }; }, async *chat() { yield { type: 'token', text: 'ok' }; yield { type: 'done', usage: {} }; } };
  const scope = { specs: () => [{ name: 't', description: '', params: {} }], run: async () => ({ ok: true, text: '' }), loaded: () => ['core', 'media'], hints: () => [] };
  const sessions = { create: () => ({ id: crypto.randomUUID(), messages: [] }), load: () => null, save() {} };
  const orch = createOrchestrator({
    bus: createBus(), sessions, providers: { get: () => provider }, tools: { turn: () => scope, specs: scope.specs }, getConfig: () => ({ provider: 'p' }),
    selectGroups: () => ['core'],
  });
  for (let i = 0; i < 80; i++) await orch.send(null, 'hi');
  assert.deepEqual(orch.stats(), { sessions: 64, cap: 64 });
});

// ---- voice controller ----
test('voice: frames heard while speech-to-text does not answer are capped like the capture', async () => {
  const stt = { id: 's', label: 'S', transcribe: () => new Promise(() => {}) };
  const vc = createVoiceController({
    bus: createBus(), orchestrator: { busy: false, stop() {}, send: async () => ({ reply: '', sessionId: 's' }) },
    engines: { stt, tts: null, wake: null }, getConfig: () => ({ ...DEFAULTS, continuationGuard: true }), getSessionId: () => 's',
  });
  vc.listen();
  for (const f of [...noise(300), ...tone(800), ...noise(1200)]) vc.feed(f, 16000);
  assert.equal(vc.mode, 'working');
  for (let i = 0; i < 60 * 50; i++) vc.feed(new Int16Array(320), 16000);   // one minute of mic frames
  const s = vc.stats();
  assert.equal(s.capMs, 31000);
  assert.ok(s.pendingMs > 30000 && s.pendingMs <= s.capMs, `pending ${s.pendingMs} ms`);
  vc.cancel();
});

// Real timers would make these 30-60 s: the mock clock moves them, and `flush` lets the promise chain settle.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const speech = () => [...noise(300), ...tone(800), ...noise(1200)];

test('voice: a speech-to-text call that never answers ends the turn after 60 s and aborts the call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const stt = { id: 's', label: 'S', transcribe: (pcm, rate, sig) => { signal = sig; return new Promise(() => {}); } };
  const bus = createBus();
  const logs = [], states = [];
  bus.on('log', l => logs.push(l)); bus.on('state', s => states.push(s.state));
  const vc = createVoiceController({
    bus, orchestrator: { busy: false, stop() {}, send: async () => ({ reply: '', sessionId: 's' }) },
    engines: { stt, tts: null, wake: null }, getConfig: () => ({ ...DEFAULTS }), getSessionId: () => 's',
  });
  vc.listen();
  for (const f of speech()) vc.feed(f, 16000);
  assert.equal(vc.mode, 'working');
  t.mock.timers.tick(59000); await flush();
  assert.equal(vc.mode, 'working');
  t.mock.timers.tick(1000); await flush();
  assert.equal(vc.mode, 'idle');
  assert.equal(signal.aborted, true);
  assert.equal(states.at(-1), 'idle');
  assert.deepEqual(logs.filter(l => l.level === 'warn').map(l => l.text), ['Speech-to-text failed: timed out after 60 s. Using text only.']);
});

test('voice: a hung wake-word transcription frees the listener after 30 s, so the next "Jarvis" is heard', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stt = { id: 's', label: 'S', transcribe: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve('Jarvis')) };
  const wake = { id: 'w', label: 'W', kind: 'listen' };
  const bus = createBus();
  const logs = [], wakes = [];
  bus.on('log', l => logs.push(l)); bus.on('wake', w => wakes.push(w));
  const vc = createVoiceController({
    bus, orchestrator: { busy: false, stop() {}, send: async () => ({ reply: '', sessionId: 's' }) },
    engines: { stt, tts: null, wake }, getConfig: () => ({ ...DEFAULTS, wakeEnabled: true }), getSessionId: () => 's',
  });
  vc.applyWake();
  for (const f of speech()) vc.feed(f, 16000);
  for (const f of speech()) vc.feed(f, 16000);   // heard while the first call hangs: skipped
  assert.equal(calls, 1);
  t.mock.timers.tick(30000); await flush();
  for (const f of speech()) vc.feed(f, 16000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(wakes.length, 1);
  assert.equal(logs.filter(l => l.level === 'warn').length, 1);
  vc.cancel();
});

test('pc host: every command that returns quickly has a limit; recycle and power (they can wait on the user or a sleeping PC) have none', async () => {
  const seen = {};
  const request = async (cmd, args, o) => { seen[cmd] = o?.timeoutMs; return cmd === 'alive' ? [] : null; };
  const h = createPcHost({ request });
  await h.windows(); await h.alive([4]); await h.launch('notepad'); await h.startApps(); await h.wifi();
  await h.recycle('C:\\tmp\\x.txt').catch(() => {}); await h.power('sleep').catch(() => {});
  assert.deepEqual(seen, { windows: 10000, alive: 10000, launch: 15000, startApps: 30000, wifi: 20000, recycle: undefined, power: undefined });
  const cmds = fs.readFileSync(PC_HOST_SCRIPT, 'utf8').match(/^ {6}'([A-Za-z]+)' \{/gm).map(l => l.match(/'(.+)'/)[1]);
  const unbounded = cmds.filter(c => !LIMIT_MS[c]);
  assert.deepEqual(unbounded.sort(), ['power', 'recycle']);
});

test('speech host: speak and transcribe are limited by their text and audio length; status and stops by a flat limit', async () => {
  const seen = [];
  const host = { request: (cmd, args, o) => { seen.push([cmd, o?.timeoutMs]); return Object.assign(Promise.resolve(cmd === 'status' ? { tts: true, stt: true } : ''), { id: 1 }); }, on: () => () => {} };
  await windowsTts(host).status();
  const h = windowsTts(host).speak('x'.repeat(1000), {});
  await h.done;
  await windowsStt(host).transcribe(new Int16Array(16000 * 10), 16000);
  await windowsWake(host).stop();
  assert.deepEqual(seen, [['status', 15000], ['speak', 330000], ['transcribe', 30000], ['wake-stop', 5000]]);
});

test('speech host: a speak that times out is told to stop talking', async () => {
  const host = hungHost();
  const tts = windowsTts(host);
  const sent = [];
  const realReq = host.request;
  host.request = (cmd, args, o) => { sent.push(cmd); return realReq(cmd, args, cmd === 'speak' ? { timeoutMs: 10 } : o); };
  const h = tts.speak('hi', {});
  await assert.rejects(h.done, /timed out/);
  await tick(5);
  assert.deepEqual(sent, ['speak', 'stop-speak']);
  host.close();
});

// ---- action log ----
test('actions.log: memory and file stay under the cap, and the newest undoable move survives however old it is', () => {
  const file = path.join(tmp(), 'actions.log');
  const logA = createActionLog({ file });
  logA.write({ what: 'recycle', ok: true, undo: [{ from: 'a', to: 'b' }] });
  const first = logA.lastUndoable().id;
  for (let i = 0; i < 2500; i++) logA.write({ what: 'focus', ok: true });
  const lines = () => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length;
  assert.ok(logA.stats().entries <= logA.stats().cap && logA.stats().entries >= 500, `entries ${logA.stats().entries}`);
  assert.ok(lines() <= logA.stats().cap);
  assert.equal(logA.lastUndoable().id, first);
  // a restart reads the same state; a file that grew before the cap existed is cut on load
  assert.equal(createActionLog({ file }).lastUndoable().id, first);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').repeat(5));
  const big = createActionLog({ file });
  assert.ok(big.stats().entries <= 1000 && lines() <= 1000);
  // after the undo, the move is no longer offered
  logA.write({ what: 'undo', ok: true, undid: first });
  assert.equal(logA.lastUndoable(), null);
});

// ---- main process: windows and mic (electron is stubbed) ----
function withElectron(stub, load) {
  const Module = require('node:module');
  const real = Module._load;
  Module._load = (req, ...a) => (req === 'electron' ? stub : real(req, ...a));
  try { return load(); } finally { Module._load = real; }
}

test('mic: waiting for a page that never loads gives up after 10 s and stops polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  class BrowserWindow { constructor() { this.webContents = { send() {} }; } loadFile() {} on() {} isDestroyed() { return false; } }
  const { createMic } = withElectron({ BrowserWindow, ipcMain: { on() {} } }, () => require('../src/main/mic'));
  const mic = createMic({ getDeviceId: () => null, onFrame() {}, onStatus() {} });
  let err = null;
  const playing = mic.play(new Int16Array(160), 16000).catch(e => { err = e; });
  for (let i = 0; i < 400; i++) t.mock.timers.tick(20);   // 8 s at the 20 ms poll
  await flush();
  assert.equal(err, null);
  for (let i = 0; i < 200; i++) t.mock.timers.tick(20);
  await playing;
  assert.match(err.message, /did not load/);
});

test('windows: the level meter (50 per second while the mic is open) is sent only to a window that is on screen', () => {
  const sent = [];
  let visible = false;
  class BrowserWindow {
    constructor() { this.webContents = { send: (ch, p) => sent.push(p.type), isDevToolsOpened: () => false }; }
    setMenu() {} loadFile() {} on() {} isDestroyed() { return false; } isVisible() { return visible; }
  }
  const { createWindows } = withElectron({ app: {}, BrowserWindow, screen: {} }, () => require('../src/main/windows'));
  const w = createWindows();
  w.ensureChat();
  for (let i = 0; i < 3000; i++) w.sendAll('ai:event', { type: 'level', source: 'mic', rms: 0.1 });   // one minute of listening
  w.sendAll('ai:event', { type: 'state', state: 'idle' });
  assert.deepEqual(sent, ['state']);
  visible = true;
  w.sendAll('ai:event', { type: 'level', source: 'mic', rms: 0.1 });
  assert.deepEqual(sent, ['state', 'level']);
});

// ---- silero ----
test('silero: when inference stops answering, the backlog is capped and the failure is reported once', async () => {
  class Tensor { constructor(type, data) { this.data = data; } }
  let runs = 0;
  const errors = [];
  const model = { ort: { Tensor }, names: { input: 'input', state: 'state', sr: 'sr', output: 'output', stateN: 'stateN' }, run: () => { runs++; return new Promise(() => {}); } };
  const stream = createSileroStream(model, { onError: e => errors.push(e.message) });
  for (let i = 0; i < 3000; i++) stream.push(new Int16Array(320), 16000);   // one minute of audio
  await tick();
  assert.equal(runs, 1);
  assert.deepEqual(errors, ['inference is not keeping up with the microphone']);
  // a reset (the next capture) starts clean
  let probs = 0;
  model.run = async () => ({ output: { data: [0.9] }, stateN: { data: new Float32Array(256) } });
  const next = createSileroStream(model, { onProb: () => probs++ });
  for (let i = 0; i < 16; i++) next.push(new Int16Array(320), 16000);
  await next.idle();
  assert.equal(probs, 10);
});

// ---- host process ----
function hungHost() {
  const kid = new EventEmitter();
  kid.stdout = new EventEmitter(); kid.stderr = new EventEmitter();
  kid.stdin = Object.assign(new EventEmitter(), { write() { return true; } });
  kid.kill = () => {};
  return createSpeechHost({ spawn: () => kid, name: 'media host' });
}

test('host: a request with a timeout is rejected and forgotten when the host does not answer', async () => {
  const host = hungHost();
  await assert.rejects(host.request('state', {}, { timeoutMs: 10 }), /media host timed out/);
  assert.deepEqual(host.stats(), { pending: 0 });
  // without a timeout the request waits, as before (speech can take minutes)
  host.request('speak', { text: 'x' }).catch(() => {});
  await tick(30);
  assert.deepEqual(host.stats(), { pending: 1 });
  host.close();
});

test('media: a read that times out leaves nothing waiting in the host', async () => {
  const host = hungHost();
  const media = createMediaService({ request: (cmd, args, o) => host.request(cmd, args, o), timeoutMs: 15 });
  await assert.rejects(media.state(), /timed out/);
  await tick(30);
  assert.deepEqual(host.stats(), { pending: 0 });
  host.close();
});

// ---- extension link ----
test('link: a fragmented message that never ends is refused at the frame limit', async () => {
  const link = startYtMusicLink({ ports: [47841, 47842], extensionId: 'testext' });
  const port = await link.started;
  const s = net.connect(port, '127.0.0.1');
  await new Promise(r => s.once('connect', r));
  s.write(`GET /ytmusic HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: chrome-extension://testext\r\n\r\n`);
  await new Promise(r => s.once('data', r));
  assert.equal(link.connected, true);
  const closed = new Promise(r => s.once('close', r));
  s.on('error', () => {});
  const part = frame(1, Buffer.alloc(3 * 1024 * 1024, 0x20));
  part[0] &= 0x7f;   // not the final fragment
  s.write(part); s.write(part);   // 6 MB of one message, limit 4 MB
  await closed;
  assert.equal(link.connected, false);
  await link.close();
});

// ---- memory watch ----
test('memwatch: levels follow resident memory; parts are asked to trim while over the limit; changes go on the bus', () => {
  let rss = 100;
  const trims = [];
  const events = [];
  const logs = [];
  const bus = createBus(); bus.on('memory', e => events.push(e));
  const watch = createMemWatch({
    bus, log: l => logs.push(l), warnMB: 400, criticalMB: 800,
    usage: () => ({ rss: rss * 1048576, heapUsed: 50 * 1048576, external: 5 * 1048576 }),
    sources: {
      cache: { stats: () => ({ entries: 3 }), trim: () => trims.push('cache') },
      plain: { stats: () => ({ pending: 0 }) },
      broken: { stats: () => { throw new Error('boom'); }, trim: () => { throw new Error('boom'); } },
    },
  });
  assert.equal(watch.check().level, 'ok');
  assert.deepEqual([trims.length, events.length], [0, 0]);
  rss = 450;
  const warn = watch.check();
  assert.equal(warn.level, 'warn');
  assert.deepEqual(warn.components, { cache: { entries: 3 }, plain: { pending: 0 }, broken: null });
  assert.deepEqual(trims, ['cache']);
  watch.check();                       // still over: trims again, no second event
  assert.deepEqual([trims.length, events.length], [2, 1]);
  rss = 900;
  assert.equal(watch.check().level, 'critical');
  rss = 120;
  const ok = watch.check();
  assert.deepEqual([ok.level, ok.rssMB, ok.peakMB], ['ok', 120, 900]);
  assert.deepEqual(events.map(e => e.level), ['warn', 'critical', 'ok']);
  assert.equal(logs.length, 3);
  assert.match(logs[0], /^memory warn: warn: /);   // self_log finds it as a fault line
});

test('memwatch: start() and stop() own one timer', async () => {
  let n = 0;
  const watch = createMemWatch({ intervalMs: 5, usage: () => { n++; return { rss: 1, heapUsed: 1, external: 0 }; } });
  watch.start(); watch.start();
  await tick(40);
  watch.stop();
  const seen = n;
  assert.ok(seen >= 2);
  await tick(30);
  assert.equal(n, seen);
});

test('selfChecks: memory reports use, peak and the lookup cache; over the limit is a problem', async () => {
  const snap = level => ({ level, rssMB: 120, peakMB: 150, warnMB: 400, components: { fetchCache: { chars: 2048, capChars: 8192, evicted: 4 }, wallpaperLink: { dropped: 1 } } });
  const run = level => selfChecks({ memwatch: { check: () => snap(level) } }).find(c => c.id === 'memory').run();
  assert.equal(run('ok'), '120 MB in use (peak 150 MB, warns at 400 MB); lookup cache 2 of 8 KB, 4 dropped; 1 stalled wallpaper connections dropped');
  assert.deepEqual(run('warn'), { ok: false, detail: 'warn: 120 MB in use (peak 150 MB, warns at 400 MB); lookup cache 2 of 8 KB, 4 dropped; 1 stalled wallpaper connections dropped' });
});
