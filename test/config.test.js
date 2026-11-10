const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, loadConfig, saveConfig } = require('../src/core/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-cfg-'));

test('config: missing file → DEFAULTS', () => {
  assert.deepEqual(loadConfig(tmp()), DEFAULTS);
  assert.equal(DEFAULTS.provider, 'null');
  assert.equal(DEFAULTS.port, 47801);
  assert.deepEqual(DEFAULTS.hotkeys, { chat: 'Control+Space', voice: 'Control+Shift+Space' });
});

test('config: unknown keys dropped, bad types → default for that key', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
    voiceRate: 'x', bogus: 1, wakeEnabled: true, engines: { stt: 'foo', tts: 5, extra: 'y' }, hotkeys: 'nope', micDeviceId: 'abc',
  }));
  const c = loadConfig(d);
  assert.equal(c.voiceRate, 1.0);
  assert.equal('bogus' in c, false);
  assert.equal(c.wakeEnabled, true);
  assert.deepEqual(c.engines, { stt: 'foo', tts: 'piper', wake: 'windows' });
  assert.deepEqual(c.hotkeys, DEFAULTS.hotkeys);
  assert.equal(c.micDeviceId, 'abc');
});

test('config: saveConfig then loadConfig round-trips', () => {
  const d = tmp();
  const c = { ...DEFAULTS, voiceRate: 1.5, hotkeys: { chat: 'Control+Alt+J', voice: 'Control+Shift+Space' } };
  saveConfig(d, c);
  assert.deepEqual(loadConfig(d), c);
});

test('config: corrupt JSON → DEFAULTS and file renamed config.broken.json', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'config.json'), '{not json');
  assert.deepEqual(loadConfig(d), DEFAULTS);
  assert.equal(fs.existsSync(path.join(d, 'config.broken.json')), true);
  assert.equal(fs.existsSync(path.join(d, 'config.json')), false);
});

test('config: DEFAULTS is not mutated by callers', () => {
  const c = loadConfig(tmp());
  c.engines.stt = 'zzz';
  assert.equal(DEFAULTS.engines.stt, 'whisper');
});
