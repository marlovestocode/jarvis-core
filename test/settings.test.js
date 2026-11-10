const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../src/core/config');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createEngineRegistries } = require('../src/core/voice/engines');
const { applyPatch, describe: describeSettings } = require('../src/core/settings');

function regs() {
  const providers = createRegistry();
  providers.add(NullProvider);
  const engines = createEngineRegistries();
  engines.tts.add({ id: 'windows', label: 'Windows speech', async status() { return { ready: true, detail: 'ok' }; }, speak() {} });
  return { providers, engines };
}

test('applyPatch: valid fields change, unknown ids and bad values are refused', () => {
  const { providers, engines } = regs();
  const cfg = { ...DEFAULTS, engines: { ...DEFAULTS.engines }, hotkeys: { ...DEFAULTS.hotkeys } };
  const { config, errors } = applyPatch(cfg, {
    voiceRate: 1.5, wakeEnabled: true, micDeviceId: 'abc', provider: 'gpt-x',
    engines: { tts: 'windows', stt: 'nope' }, hotkeys: { chat: 'Control+Alt+J' }, port: 1, junk: 1,
  }, { providers, engines });
  assert.equal(config.voiceRate, 1.5);
  assert.equal(config.wakeEnabled, true);
  assert.equal(config.micDeviceId, 'abc');
  assert.equal(config.provider, 'null', 'unknown provider refused');
  assert.equal(config.engines.tts, 'windows');
  assert.equal(config.engines.stt, DEFAULTS.engines.stt, 'unknown engine refused');
  assert.equal(config.hotkeys.chat, 'Control+Alt+J');
  assert.equal(config.hotkeys.voice, 'Control+Shift+Space');
  assert.equal(config.port, DEFAULTS.port, 'port not settable from the UI');
  assert.equal('junk' in config, false);
  assert.ok(errors.some(e => /provider/.test(e)) && errors.some(e => /stt/.test(e)));
  assert.equal(cfg.voiceRate, 1.0, 'input not mutated');
});

test('applyPatch: voice rate clamped to 0.5..2.0; same hotkey twice refused; empty hotkey refused', () => {
  const { providers, engines } = regs();
  assert.equal(applyPatch(DEFAULTS, { voiceRate: 7 }, { providers, engines }).config.voiceRate, 2);
  assert.equal(applyPatch(DEFAULTS, { voiceRate: 0.1 }, { providers, engines }).config.voiceRate, 0.5);
  const dup = applyPatch(DEFAULTS, { hotkeys: { chat: 'Control+Shift+Space' } }, { providers, engines });
  assert.equal(dup.config.hotkeys.chat, 'Control+Space');
  assert.ok(dup.errors.length);
  assert.equal(applyPatch(DEFAULTS, { hotkeys: { voice: '' } }, { providers, engines }).config.hotkeys.voice, 'Control+Shift+Space');
  assert.equal(applyPatch(DEFAULTS, { micDeviceId: null }, { providers, engines }).config.micDeviceId, null);
});

test('describe: config, providers with status detail, engines with readiness, hotkey failures', async () => {
  const { providers, engines } = regs();
  const d = await describeSettings({ config: DEFAULTS, providers, engines, hotkeyFailures: ['Control+Space'] });
  assert.deepEqual(d.config, DEFAULTS);
  assert.deepEqual(d.providers, [{ id: 'null', label: 'No model', ready: false, detail: 'No model set' }]);
  assert.deepEqual(d.engines.tts.map(e => [e.id, e.ready]), [['none', false], ['windows', true]]);
  assert.deepEqual(d.hotkeyFailures, ['Control+Space']);
});

test('describe: a status() that throws or hangs does not break the panel', async () => {
  const { providers, engines } = regs();
  engines.stt.add({ id: 'bad', label: 'Bad', async status() { throw new Error('dead'); } });
  engines.wake.add({ id: 'slow', label: 'Slow', status: () => new Promise(() => {}) });
  const d = await describeSettings({ config: DEFAULTS, providers, engines, hotkeyFailures: [], statusTimeoutMs: 50 });
  assert.deepEqual(d.engines.stt.find(e => e.id === 'bad'), { id: 'bad', label: 'Bad', ready: false, detail: 'dead' });
  assert.equal(d.engines.wake.find(e => e.id === 'slow').ready, false);
});

test('knowledge settings: switches, location, units, HTTPS feeds and followed teams', () => {
  const r = applyPatch(DEFAULTS, { online: { enabled: false, weather: false }, location: { city: 'London, UK', lat: 51.5, lon: -0.12, country: 'GB', units: 'C' }, news: { feeds: ['https://feeds.bbci.co.uk/news/rss.xml'] }, sports: { follow: [{ league: 'nfl', team: 'Cowboys' }] } }, regs());
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.online.enabled, false);
  assert.equal(r.config.online.news, true);
  assert.equal(r.config.location.country, 'GB');
  assert.equal(r.config.location.units, 'C');
  assert.equal(r.config.location.lat, 51.5);
  assert.equal(r.config.news.feeds.length, 1);
  assert.deepEqual(r.config.sports.follow, [{ league: 'nfl', team: 'Cowboys' }]);
  assert.equal(DEFAULTS.online.enabled, true);
});

test('knowledge settings: reject malformed switches, coordinates, feeds and teams', () => {
  const patch = { online: { wiki: 'false' }, location: { city: '', lat: 91, lon: '5', units: 'K' }, news: { feeds: ['http://evil.example/rss', 'https://127.0.0.1/rss', 'https://localhost/rss', 'https://user:pass@feeds.bbci.co.uk/rss'] }, sports: { follow: [{ league: 'bogus', team: '' }] } };
  const r = applyPatch(DEFAULTS, patch, regs());
  assert.ok(r.errors.length >= 5);
  assert.deepEqual(r.config.online, DEFAULTS.online);
  assert.deepEqual(r.config.location, DEFAULTS.location);
  assert.deepEqual(r.config.news, DEFAULTS.news);
  assert.deepEqual(r.config.sports, DEFAULTS.sports);
});

test('describe: library readiness is returned without requiring an installed library', async () => {
  const library = { installed: false, path: 'C:\\JarvisData\\library', articles: null, running: false, sizeBytes: 0 };
  const d = await describeSettings({ config: DEFAULTS, ...regs(), library });
  assert.deepEqual(d.library, library);
});

test('applyPatch: routing (auto, fast model) and start with Windows', () => {
  const { providers, engines } = regs();
  const { config, errors } = applyPatch(DEFAULTS, { startAtLogin: false, ollama: { auto: false, fastModel: 'qwen3.5:2b' } }, { providers, engines });
  assert.equal(config.startAtLogin, false);
  assert.equal(config.ollama.auto, false);
  assert.equal(config.ollama.fastModel, 'qwen3.5:2b');
  assert.deepEqual(errors, []);
  assert.equal(DEFAULTS.startAtLogin, true);
  assert.equal(DEFAULTS.ollama.auto, true);
  assert.equal(DEFAULTS.ollama.fastModel, '', 'quick chat uses the main model unless set');
  assert.equal(DEFAULTS.ollama.keepAlive, '30m');
  assert.equal(applyPatch(DEFAULTS, { ollama: { fastModel: '' } }, { providers, engines }).config.ollama.fastModel, '');
});

test('applyPatch: vad accepts silero or energy, refuses anything else', () => {
  const { providers, engines } = regs();
  assert.equal(applyPatch(DEFAULTS, { vad: 'energy' }, { providers, engines }).config.vad, 'energy');
  const bad = applyPatch(DEFAULTS, { vad: 'neural' }, { providers, engines });
  assert.equal(bad.config.vad, DEFAULTS.vad);
  assert.ok(bad.errors.some(e => /VAD/i.test(e)));
});
