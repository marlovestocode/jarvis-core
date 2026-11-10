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
  assert.deepEqual(c.engines, { stt: 'foo', tts: 'piper', wake: 'whisper' });
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

test('config: vad is silero by default (Gate 1); only silero or energy are kept', () => {
  assert.equal(DEFAULTS.vad, 'silero');
  for (const [v, want] of [['silero', 'silero'], ['energy', 'energy'], ['foo', 'silero'], [3, 'silero']]) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ vad: v }));
    assert.equal(loadConfig(d).vad, want, String(v));
  }
});

test('config: sttModel defaults to small.en and sttGpu to true; a bare .bin file name is kept, anything else refused', () => {
  assert.equal(DEFAULTS.sttModel, 'ggml-small.en-q5_1.bin');
  assert.equal(DEFAULTS.sttGpu, true);
  for (const [v, want] of [['ggml-base.en.bin', 'ggml-base.en.bin'], ['../evil.bin', 'ggml-small.en-q5_1.bin'], ['x.exe', 'ggml-small.en-q5_1.bin'], [5, 'ggml-small.en-q5_1.bin']]) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ sttModel: v }));
    assert.equal(loadConfig(d).sttModel, want, String(v));
  }
  const d = tmp();
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ sttGpu: 'yes' }));
  assert.equal(loadConfig(d).sttGpu, true);
});

test('config: sttPrompt is v0 by default; only v0, v1 or none are kept', () => {
  assert.equal(DEFAULTS.sttPrompt, 'v0');
  for (const [v, want] of [['v1', 'v1'], ['none', 'none'], ['v9', 'v0'], [1, 'v0']]) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ sttPrompt: v }));
    assert.equal(loadConfig(d).sttPrompt, want, String(v));
  }
});

test('config: wakeInterrupt is now by default; now or sentence are kept', () => {
  assert.equal(DEFAULTS.wakeInterrupt, 'now');
  for (const [v, want] of [['sentence', 'sentence'], ['now', 'now'], ['later', 'now'], [true, 'now']]) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ wakeInterrupt: v }));
    assert.equal(loadConfig(d).wakeInterrupt, want, String(v));
  }
});

test('config: endSilenceMs (700 = old) is clamped to 300..1500; continuationGuard is a boolean, off until Gate 4', () => {
  assert.equal(DEFAULTS.endSilenceMs, 700);
  assert.equal(DEFAULTS.continuationGuard, false);
  for (const [v, want] of [[550, 550], [100, 300], [9000, 1500], ['x', 700]]) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ endSilenceMs: v, continuationGuard: true }));
    const c = loadConfig(d);
    assert.equal(c.endSilenceMs, want, String(v));
    assert.equal(c.continuationGuard, true);
  }
});
