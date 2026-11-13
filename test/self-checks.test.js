const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selfChecks } = require('../src/main/checks');
const { runChecks } = require('../src/core/self/diagnostics');
const { DEFAULTS } = require('../src/core/config');

// A stand-in for the app's ctx (src/main/main.js) with every part healthy; tests then break one part at a time.
function fakeCtx(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jchk-'));
  const engines = {
    stt: { id: 'whisper', label: 'Whisper', status: async () => ({ ready: true, detail: 'small.en' }) },
    tts: { id: 'piper', label: 'Piper', status: async () => ({ ready: true, detail: '' }) },
    wake: { id: 'whisper', label: 'Whisper on your mic', status: async () => ({ ready: true, detail: '' }) },
  };
  const ollama = { id: 'ollama', label: 'Ollama', status: async () => ({ ready: true, detail: 'jarvis-worker loaded' }) };
  return {
    dataDir, version: '0.1.0', startedAt: Date.now() - 90 * 60000,
    config: { ...DEFAULTS, provider: 'ollama', wakeEnabled: true, browser: { enabled: true } },
    bootLog: [{ stage: 'core', ok: true, detail: 'v0.1.0', ms: 1 }, { stage: 'done', ok: true, detail: '1 of 1 ready', ms: 900 }],
    providers: { get: id => ({ ollama, null: { id: 'null', label: 'No model' } })[id] },
    pickEngine: kind => engines[kind],
    micOk: true,
    speaker: { available: () => true, enrolled: () => true, count: () => 3 },
    bridge: { port: 47801, clients: () => 1 },
    ytmLink: { port: 47830, connected: true },
    kiwix: { available: () => true, info: async () => ({ file: 'wikipedia_en.zim', articles: 6000000, running: true }) },
    pcAllowlist: async () => ['a', 'b'],
    media: { state: async () => ({}) },
    scheduler: { list: () => [{}, {}] },
    hotkeys: { failed: [], registered: ['Control+Space'] },
    memwatch: { check: () => ({ level: 'ok', rssMB: 60, peakMB: 60, warnMB: 400, components: {} }) },
    memorySystem: { check: () => ({ level: 'ok', detail: 'ollama:nomic-embed-text@768; 12 nodes' }) },
    ...over,
  };
}
const run = async (ctx, fetch = async () => ({ ok: true })) => Object.fromEntries((await runChecks(selfChecks(ctx, { fetch }))).map(r => [r.id, r]));

test('selfChecks: a healthy app has no problems', async () => {
  const r = await run(fakeCtx());
  assert.deepEqual(Object.values(r).filter(x => x.state !== 'ok').map(x => `${x.id}: ${x.detail}`), []);
  assert.equal(r.core.detail, 'v0.1.0, running for 1 h 30 min');
  assert.equal(r.startup.detail, '1 of 1 ready in 900 ms');
  assert.equal(r.model.detail, 'Ollama: jarvis-worker loaded');
  assert.equal(r['speech-to-text'].detail, 'Whisper (small.en)');
  assert.equal(r['wallpaper link'].detail, '127.0.0.1:47801, wallpaper connected');
  assert.equal(r['offline library'].detail, 'wikipedia_en.zim, 6,000,000 articles');
  assert.equal(r['online lookups'].detail, 'on: weather, news, sports, wiki, web, lyrics');
  assert.equal(r.timers.detail, '2 set');
  assert.equal(r.settings.detail, 'no config.json yet, defaults in use');
});

test('selfChecks: parts that are switched off or not installed are off, not problems', async () => {
  const ctx = fakeCtx({
    config: { ...DEFAULTS },   // no model, wake word off, browser off
    speaker: { available: () => true, enrolled: () => false, count: () => 0 },
    ytmLink: { port: 47830, connected: false },
    kiwix: { available: () => false },
    bootLog: [{ stage: 'sysmon', ok: false, detail: 'not running', ms: 3 }, { stage: 'done', ok: false, detail: '0 of 1 ready', ms: 50 }],
  });
  const r = await run(ctx, async () => { throw new Error('down'); });
  const off = Object.values(r).filter(x => x.state === 'off').map(x => x.id).sort();
  assert.deepEqual(off, ['browser skills', 'chrome extension', 'model', 'offline library', 'startup', 'sysmon', 'voice recognition', 'wake word']);
  assert.deepEqual(Object.values(r).filter(x => x.state === 'fail'), []);
  assert.equal(r.startup.detail, '0 of 1 ready in 50 ms; off at startup: sysmon (not running)');
  assert.equal(r['chrome extension'].detail, 'not connected (listening on 127.0.0.1:47830)');
});

test('selfChecks: real faults are problems, each with its reason', async () => {
  const ctx = fakeCtx({
    providers: { get: () => ({ id: 'ollama', label: 'Ollama', status: async () => { throw new Error('connect ECONNREFUSED'); } }) },
    pickEngine: kind => (kind === 'stt' ? { id: 'windows', label: 'Windows speech', status: async () => ({ ready: true }) } : kind === 'tts' ? { id: 'none', label: 'None' } : { id: 'whisper', label: 'Whisper on your mic', status: async () => ({ ready: false, detail: 'Whisper is not installed' }) }),
    micOk: false,
    bridge: null,
    ytmLink: { port: null, connected: false },
    pcAllowlist: async () => [],
    media: { state: async () => { throw new Error('media host exited'); } },
    hotkeys: { failed: ['Control+Space'], registered: [] },
  });
  fs.writeFileSync(path.join(ctx.dataDir, 'config.json'), JSON.stringify({ vad: 'nope' }));
  const r = await run(ctx);
  const fail = Object.fromEntries(Object.values(r).filter(x => x.state === 'fail').map(x => [x.id, x.detail]));
  assert.deepEqual(fail, {
    settings: 'ignored or adjusted entries in config.json: vad',
    model: 'Ollama: connect ECONNREFUSED',
    'speech-to-text': 'whisper is set but not available; using Windows speech',
    'text-to-speech': 'no engine (piper is set)',
    'wake word': 'Whisper on your mic: Whisper is not installed',
    microphone: 'unavailable',
    'wallpaper link': 'the bridge did not start',
    'chrome extension': 'the link is not listening',
    'browser skills': 'on in settings, but the Chrome extension is not connected',
    'pc control': 'no apps could be read from the Start menu',
    media: 'media host exited',
    hotkeys: 'taken by another app: Control+Space',
  });
});

test('selfChecks: cortex check ok / off / problem', async () => {
  assert.equal((await run(fakeCtx())).cortex.detail, 'ollama:nomic-embed-text@768; 12 nodes');
  const off = (await run(fakeCtx({ memorySystem: { check: () => ({ level: 'off', detail: 'nomic-embed-text is not installed' }) } }))).cortex;
  assert.equal(off.state, 'off');
  const bad = (await run(fakeCtx({ memorySystem: { check: () => ({ level: 'bad', detail: 'the cortex is read-only' }) } }))).cortex;
  assert.deepEqual([bad.state, bad.detail], ['fail', 'the cortex is read-only']);
  assert.equal((await run(fakeCtx({ memorySystem: null }))).cortex.state, 'off');
});
