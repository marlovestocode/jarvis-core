const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllamaProvider, mapMessages } = require('../src/core/providers/ollama');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createEngineRegistries } = require('../src/core/voice/engines');
const { applyPatch, describe } = require('../src/core/settings');
const { DEFAULTS } = require('../src/core/config');

const enc = new TextEncoder();
const CFG = { ollama: { host: 'http://127.0.0.1:11434', model: 'jarvis-worker:latest', think: false } };
const getConfig = () => CFG;

const TAGS = { models: [
  { name: 'jarvis-worker:latest', capabilities: ['completion', 'tools', 'thinking'], details: { parameter_size: '4.2B', quantization_level: 'Q4_K_M', context_length: 262144 } },
  { name: 'dolphin3:8b', capabilities: ['completion'], details: { parameter_size: '8.0B' } },
  { name: 'glm-5.3:cloud', remote_model: 'glm-5.3', remote_host: 'https://ollama.com', details: {} },
] };
const SHOW = { parameters: 'num_ctx 8192\ntemperature 0.3', capabilities: ['tools', 'thinking'] };

function ndjson(lines) {
  return new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } });
}
function jsonRes(obj, ok = true, status = 200) { return { ok, status, json: async () => obj }; }

// routes: { '/api/tags': obj|throw, '/api/show': obj, '/api/chat': response }
function fakeFetch(routes, calls = []) {
  return async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: opts.body ? JSON.parse(opts.body) : null, signal: opts.signal, redirect: opts.redirect });
    const r = routes[path];
    if (typeof r === 'function') return r(opts);
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error('fetch failed: ' + path);
    return r;
  };
}

const chatLines = [
  { message: { role: 'assistant', content: 'Hello' }, done: false },
  { message: { role: 'assistant', content: ' world' }, done: false },
  { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 12, eval_count: 5 },
];

function standardRoutes(chatResponse) {
  return { '/api/tags': jsonRes(TAGS), '/api/show': jsonRes(SHOW), '/api/chat': chatResponse ?? { ok: true, status: 200, body: ndjson(chatLines) } };
}

async function collect(it) { const out = []; for await (const c of it) out.push(c); return out; }

test('ollama status: server down → not ready', async () => {
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch({ '/api/tags': new Error('ECONNREFUSED') }) });
  const st = await p.status();
  assert.equal(st.ready, false);
  assert.match(st.detail, /not running/);
});

test('ollama status: model missing → not ready, names the model', async () => {
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...CFG.ollama, model: 'nope:1' } }), fetch: fakeFetch(standardRoutes()) });
  const st = await p.status();
  assert.equal(st.ready, false);
  assert.match(st.detail, /nope:1/);
});

test('ollama status: ready with contextMax from num_ctx and size detail', async () => {
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch(standardRoutes()) });
  const st = await p.status();
  assert.equal(st.ready, true);
  assert.equal(st.contextMax, 8192);
  assert.match(st.detail, /jarvis-worker:latest/);
  assert.match(st.detail, /4\.2B/);
});

test('ollama chat: streams tokens in order, done carries usage', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch(standardRoutes(), calls) });
  const out = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.deepEqual(out.map(c => c.type), ['token', 'token', 'done']);
  assert.equal(out[0].text + out[1].text, 'Hello world');
  assert.deepEqual(out[2].usage, { promptTokens: 12, completionTokens: 5 });
  const body = calls.find(c => c.path === '/api/chat').body;
  assert.equal(body.model, 'jarvis-worker:latest');
  assert.equal(body.stream, true);
  assert.equal(body.think, false, 'thinking off by default for speed');
});

test('ollama chat: think:true forwarded when enabled; thinking chunks become reasoning', async () => {
  const lines = [
    { message: { thinking: 'hmm' }, done: false },
    { message: { content: 'ok' }, done: false },
    { message: { content: '' }, done: true },
  ];
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...CFG.ollama, think: true } }), fetch: fakeFetch({ ...standardRoutes(), '/api/chat': { ok: true, body: ndjson(lines) } }, calls) });
  const out = await collect(p.chat({ messages: [] }));
  assert.deepEqual(out.map(c => c.type), ['reasoning', 'token', 'done']);
  assert.equal(out[0].text, 'hmm');
  assert.equal(calls.find(c => c.path === '/api/chat').body.think, true);
});

test('ollama chat: think omitted for models without thinking capability', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...CFG.ollama, model: 'dolphin3:8b', think: true } }), fetch: fakeFetch(standardRoutes(), calls) });
  await collect(p.chat({ messages: [] }));
  assert.equal('think' in calls.find(c => c.path === '/api/chat').body, false);
});

test('ollama chat: tool_calls become tool_call chunks; tools offered to tool-capable models', async () => {
  const lines = [
    { message: { content: '', tool_calls: [{ function: { name: 'get_time', arguments: {} } }] }, done: false },
    { message: { content: '' }, done: true },
  ];
  const calls = [];
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch({ ...standardRoutes(), '/api/chat': { ok: true, body: ndjson(lines) } }, calls) });
  const specs = [{ name: 'get_time', description: 'time', params: { type: 'object' } }];
  const out = await collect(p.chat({ messages: [], tools: specs }));
  assert.equal(out[0].type, 'tool_call');
  assert.equal(out[0].name, 'get_time');
  assert.deepEqual(out[0].args, {});
  assert.ok(out[0].id);
  const body = calls.find(c => c.path === '/api/chat').body;
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'get_time', description: 'time', parameters: { type: 'object' } } }]);
});

test('ollama chat: tools withheld from models without tools capability', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...CFG.ollama, model: 'dolphin3:8b' } }), fetch: fakeFetch(standardRoutes(), calls) });
  await collect(p.chat({ messages: [], tools: [{ name: 'get_time', description: 't', params: {} }] }));
  assert.equal('tools' in calls.find(c => c.path === '/api/chat').body, false);
});

test('ollama chat: abort mid-stream throws AbortError', async () => {
  const ac = new AbortController();
  const body = new ReadableStream({ start(c) {
    c.enqueue(enc.encode(JSON.stringify(chatLines[0]) + '\n'));
    ac.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; c.error(e); }, { once: true });
  } });
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch({ ...standardRoutes(), '/api/chat': { ok: true, body } }) });
  const it = p.chat({ messages: [], signal: ac.signal })[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.text, 'Hello');
  const pending = it.next();
  ac.abort();
  await assert.rejects(pending, e => e.name === 'AbortError');
});

test('ollama chat: pre-aborted signal throws before any fetch', async () => {
  const ac = new AbortController(); ac.abort();
  const calls = [];
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch(standardRoutes(), calls) });
  await assert.rejects(collect(p.chat({ messages: [], signal: ac.signal })), e => e.name === 'AbortError');
  assert.equal(calls.length, 0);
});

test('ollama chat: HTTP error surfaces the server message', async () => {
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch({ ...standardRoutes(), '/api/chat': jsonRes({ error: 'model crashed' }, false, 500) }) });
  await assert.rejects(collect(p.chat({ messages: [] })), /model crashed/);
});

test('ollama chat: stream cut without done → error, not silent success', async () => {
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch({ ...standardRoutes(), '/api/chat': { ok: true, body: ndjson(chatLines.slice(0, 1)) } }) });
  await assert.rejects(collect(p.chat({ messages: [] })), /ended early/);
});

test('ollama listModels: local models only, size in label', async () => {
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch(standardRoutes()) });
  const models = await p.listModels();
  assert.deepEqual(models.map(m => m.id), ['jarvis-worker:latest', 'dolphin3:8b']);
  assert.match(models[0].label, /4\.2B/);
});

test('mapMessages: assistant toolCalls and tool results use Ollama shape', () => {
  const out = mapMessages([
    { role: 'user', content: 'time?' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call0', name: 'get_time', args: {} }] },
    { role: 'tool', content: '12:00', toolCallId: 'call0', name: 'get_time' },
  ]);
  assert.deepEqual(out[1], { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_time', arguments: {} } }] });
  assert.deepEqual(out[2], { role: 'tool', content: '12:00', tool_name: 'get_time' });
});

test('settings applyPatch: ollama model/think accepted, non-local host refused', () => {
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(createOllamaProvider({ getConfig }));
  const engines = createEngineRegistries();
  const ok = applyPatch(DEFAULTS, { provider: 'ollama', ollama: { model: 'qwen3:4b', think: true } }, { providers, engines });
  assert.equal(ok.config.provider, 'ollama');
  assert.equal(ok.config.ollama.model, 'qwen3:4b');
  assert.equal(ok.config.ollama.think, true);
  assert.equal(ok.errors.length, 0);
  const bad = applyPatch(DEFAULTS, { ollama: { host: 'http://evil.com:11434', model: '' } }, { providers, engines });
  assert.equal(bad.config.ollama.host, DEFAULTS.ollama.host);
  assert.equal(bad.config.ollama.model, DEFAULTS.ollama.model);
  assert.equal(bad.errors.length, 2);
  const local = applyPatch(DEFAULTS, { ollama: { host: 'http://localhost:11434/' } }, { providers, engines });
  assert.equal(local.config.ollama.host, 'http://localhost:11434');
});

test('settings describe: includes ollama models; empty when server down', async () => {
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(createOllamaProvider({ getConfig, fetch: fakeFetch(standardRoutes()) }));
  const engines = createEngineRegistries();
  const d = await describe({ config: DEFAULTS, providers, engines });
  assert.deepEqual(d.models.map(m => m.id), ['jarvis-worker:latest', 'dolphin3:8b']);
  const down = createRegistry();
  down.add(createOllamaProvider({ getConfig, fetch: fakeFetch({ '/api/tags': new Error('down') }) }));
  const d2 = await describe({ config: DEFAULTS, providers: down, engines });
  assert.deepEqual(d2.models, []);
});

test('ollama rejects non-local persisted hosts before any request', async () => {
  for (const host of ['http://example.invalid:11434', 'http://192.168.1.2:11434', 'http://127.0.0.1.example.invalid:11434']) {
    const calls = [];
    const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...CFG.ollama, host } }), fetch: fakeFetch(standardRoutes(), calls) });
    const status = await p.status();
    assert.equal(status.ready, false);
    assert.match(status.detail, /host must be local/);
    await assert.rejects(collect(p.chat({ messages: [{ role: 'user', content: 'private' }] })), /host must be local/);
    await assert.rejects(p.listModels(), /host must be local/);
    assert.equal(calls.length, 0);
  }
});

test('ollama rejects cloud-backed configured models before sending chat', async () => {
  for (const remote of [{ remote_model: 'cloud-model' }, { remote_host: 'https://example.invalid' }]) {
    const calls = [];
    const tags = { models: [{ ...TAGS.models[0], ...remote }] };
    const p = createOllamaProvider({ getConfig, fetch: fakeFetch({ ...standardRoutes(), '/api/tags': jsonRes(tags) }, calls) });
    const status = await p.status();
    assert.equal(status.ready, false);
    assert.match(status.detail, /Cloud-backed/);
    await assert.rejects(collect(p.chat({ messages: [{ role: 'user', content: 'private' }] })), /Cloud-backed/);
    assert.deepEqual(await p.listModels(), []);
    assert.equal(calls.some(c => c.path === '/api/chat'), false);
  }
});

test('ollama disallows HTTP redirects on metadata and chat requests', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch(standardRoutes(), calls) });
  await p.listModels();
  await collect(p.chat({ messages: [] }));
  assert.ok(calls.some(c => c.path === '/api/chat'));
  assert.ok(calls.every(c => c.redirect === 'error'));
});
// ---- routing, warm-up, keep-alive ----
const AUTO = { ollama: { ...CFG.ollama, fastModel: 'jarvis-router:latest', auto: true, keepAlive: '30m' } };
const TAGS2 = { models: [...TAGS.models, { name: 'jarvis-router:latest', capabilities: ['completion', 'tools', 'thinking'], details: { parameter_size: '1.9B' } }] };
const routes2 = () => ({ ...standardRoutes(), '/api/tags': jsonRes(TAGS2), '/api/chat': () => ({ ok: true, status: 200, body: ndjson(chatLines) }) });

test('ollama auto: fast turns use the fast model, deep turns the main one; think from hints', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => AUTO, fetch: fakeFetch(routes2(), calls) });
  assert.equal(p.resolveModel({ tier: 'fast' }), 'jarvis-router:latest');
  assert.equal(p.resolveModel({ tier: 'deep' }), 'jarvis-worker:latest');
  await collect(p.chat({ messages: [], hints: { tier: 'fast', think: false } }));
  await collect(p.chat({ messages: [], hints: { tier: 'deep', think: true } }));
  const chats = calls.filter(c => c.path === '/api/chat').map(c => c.body);
  assert.deepEqual(chats.map(b => [b.model, b.think, b.keep_alive]), [['jarvis-router:latest', false, '30m'], ['jarvis-worker:latest', true, '30m']]);
});

test('ollama auto off: always the main model and the think setting', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...AUTO.ollama, auto: false, think: true } }), fetch: fakeFetch(routes2(), calls) });
  assert.equal(p.resolveModel({ tier: 'fast' }), 'jarvis-worker:latest');
  await collect(p.chat({ messages: [], hints: { tier: 'fast', think: false } }));
  const b = calls.find(c => c.path === '/api/chat').body;
  assert.deepEqual([b.model, b.think], ['jarvis-worker:latest', true]);
});

test('ollama auto: a missing fast model falls back to the main model', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...AUTO.ollama, fastModel: 'gone:1' } }), fetch: fakeFetch(routes2(), calls) });
  await collect(p.chat({ messages: [], hints: { tier: 'fast' } }));
  assert.equal(calls.find(c => c.path === '/api/chat').body.model, 'jarvis-worker:latest');
});

test('ollama done usage includes evalMs for speed', async () => {
  const lines = [{ message: { content: 'x' }, done: false }, { message: { content: '' }, done: true, prompt_eval_count: 3, eval_count: 30, eval_duration: 500e6 }];
  const p = createOllamaProvider({ getConfig, fetch: fakeFetch({ ...standardRoutes(), '/api/chat': { ok: true, body: ndjson(lines) } }) });
  const out = await collect(p.chat({ messages: [] }));
  assert.deepEqual(out.at(-1).usage, { promptTokens: 3, completionTokens: 30, evalMs: 500 });
});

test('ollama warm: loads main and fast models with keep_alive, never throws', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => AUTO, fetch: fakeFetch({ ...routes2(), '/api/generate': jsonRes({ done: true }) }, calls) });
  const r = await p.warm();
  const gens = calls.filter(c => c.path === '/api/generate').map(c => c.body);
  assert.deepEqual(gens.map(b => [b.model, b.keep_alive]), [['jarvis-worker:latest', '30m'], ['jarvis-router:latest', '30m']]);
  assert.deepEqual(r.loaded, ['jarvis-worker:latest', 'jarvis-router:latest']);
  const down = createOllamaProvider({ getConfig: () => AUTO, fetch: fakeFetch({ '/api/tags': new Error('down') }) });
  const r2 = await down.warm();
  assert.deepEqual(r2.loaded, []);
  assert.match(r2.error, /not running/);
});

test('ollama: empty fastModel means quick chat uses the main model; warm loads only it', async () => {
  const calls = [];
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { ...AUTO.ollama, fastModel: '' } }), fetch: fakeFetch({ ...routes2(), '/api/generate': jsonRes({}) }, calls) });
  assert.equal(p.resolveModel({ tier: 'fast' }), 'jarvis-worker:latest');
  const w = await p.warm();
  assert.deepEqual(w.loaded, ['jarvis-worker:latest']);
});
