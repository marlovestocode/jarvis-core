const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllamaProvider } = require('../src/core/providers/ollama');

const BASE = { host: 'http://127.0.0.1:11434', model: 'jarvis-worker:latest', think: false, fastModel: 'jarvis-router:latest', auto: true };
const model = (name, caps, size) => ({ name, capabilities: caps, details: { parameter_size: size } });
const TAGS = { models: [
  model('jarvis-worker:latest', ['completion', 'tools', 'thinking'], '4.2B'),
  model('jarvis-router:latest', ['completion', 'tools'], '1.9B'),
  model('plain:1b', ['completion'], '1.0B'),
] };

function jsonRes(obj) { return { ok: true, status: 200, json: async () => obj }; }

// a provider whose tags/models are loaded by one status() call
async function build(ollama = {}, tags = TAGS) {
  const routes = { '/api/tags': jsonRes(tags), '/api/show': jsonRes({ capabilities: [] }), '/api/ps': jsonRes({ models: [] }) };
  const fetch = async url => routes[new URL(url).pathname];
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...BASE, ...ollama } }), fetch });
  await p.status();
  return p;
}

const DEEP = { tier: 'deep', tools: true };

test('prefer fast: honored when the fast model is installed, has tools, differs, and is not avoided', async () => {
  const p = await build();
  assert.equal(p.resolveModel(DEEP), 'jarvis-worker:latest');
  assert.equal(p.resolveModel({ ...DEEP, prefer: 'fast' }), 'jarvis-router:latest');
  assert.equal(p.resolveModel({ ...DEEP, think: true, prefer: 'fast' }), 'jarvis-router:latest');
});

test('prefer fast: fast model not installed falls through to the no-prefer result', async () => {
  const p = await build({ fastModel: 'gone:1' });
  assert.equal(p.resolveModel({ ...DEEP, prefer: 'fast' }), p.resolveModel(DEEP));
});

test('prefer fast: fast model without a tools capability falls through', async () => {
  const p = await build({ fastModel: 'plain:1b' });
  assert.equal(p.resolveModel({ ...DEEP, prefer: 'fast' }), p.resolveModel(DEEP));
});

test('prefer fast: fast model same as main falls through', async () => {
  const p = await build({ fastModel: 'jarvis-worker:latest' });
  assert.equal(p.resolveModel({ ...DEEP, prefer: 'fast' }), p.resolveModel(DEEP));
});

test('prefer fast: fast model equal to hints.avoid falls through', async () => {
  const p = await build();
  const hints = { ...DEEP, avoid: 'jarvis-router:latest' };
  assert.equal(p.resolveModel({ ...hints, prefer: 'fast' }), p.resolveModel(hints));
  assert.equal(p.resolveModel({ ...hints, prefer: 'fast' }), 'jarvis-worker:latest');
});

test('prefer fast: auto off falls through', async () => {
  const p = await build({ auto: false });
  assert.equal(p.resolveModel({ ...DEEP, prefer: 'fast' }), p.resolveModel(DEEP));
  assert.equal(p.resolveModel({ ...DEEP, prefer: 'fast' }), 'jarvis-worker:latest');
});

test('prefer fast: empty fastModel falls through', async () => {
  const p = await build({ fastModel: '' });
  assert.equal(p.resolveModel({ ...DEEP, prefer: 'fast' }), p.resolveModel(DEEP));
});

test('no prefer hint: existing outcomes unchanged', async () => {
  const p = await build();
  assert.equal(p.resolveModel({ tier: 'fast' }), 'jarvis-router:latest');
  assert.equal(p.resolveModel({ tier: 'deep' }), 'jarvis-worker:latest');
  assert.equal(p.resolveModel({ tier: 'deep', avoid: 'jarvis-worker:latest', tools: true }), 'jarvis-router:latest');
  assert.equal(p.resolveModel(), 'jarvis-worker:latest');
});
