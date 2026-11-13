const test = require('node:test');
const assert = require('node:assert/strict');
const { localOrigin, sysmonUp, SYSMON, OLLAMA } = require('../src/core/net/services');
const { SYSMON: fromTool } = require('../src/core/tools/sysmon');

test('services: one definition of each local service address', () => {
  assert.equal(fromTool, SYSMON, 'the sysmon tool re-exports the shared address');
  assert.equal(SYSMON, 'http://127.0.0.1:47800');
  assert.equal(OLLAMA, 'http://127.0.0.1:11434');
});

test('services: only this PC is accepted as a model host, a trailing slash is dropped, and blank falls back', () => {
  assert.equal(localOrigin('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(localOrigin('http://[::1]:11434'), 'http://[::1]:11434');
  assert.equal(localOrigin(''), OLLAMA);
  assert.equal(localOrigin(undefined), OLLAMA);
  for (const bad of ['http://192.168.1.5:11434', 'https://ollama.com', 'http://127.0.0.1.evil.com', 'http://localhost@evil.com', 'ftp://127.0.0.1']) assert.equal(localOrigin(bad), null, bad);
});

test('services: sysmonUp is true only for an answering health check, and never throws', async () => {
  assert.equal(await sysmonUp(async url => ({ ok: url === SYSMON + '/health' })), true);
  assert.equal(await sysmonUp(async () => ({ ok: false })), false);
  assert.equal(await sysmonUp(async () => { throw new Error('refused'); }), false);
  assert.equal(await sysmonUp(() => { throw new Error('sync'); }), false);
});
