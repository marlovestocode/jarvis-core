const test = require('node:test');
const assert = require('node:assert/strict');
const { validateArgs, repairCall, firstSentence } = require('../src/core/tools/constrain');
const { createOllamaProvider } = require('../src/core/providers/ollama');
const { createFakeProvider } = require('./helpers/fake-provider');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { buildCatalog } = require('../src/core/skills');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const MEDIA = { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'stop', 'next'] }, volume: { type: 'number' } }, required: ['action'], additionalProperties: false };
const specs = [
  { name: 'get_time', description: 'The current time. Use it when asked what time it is.', params: { type: 'object', properties: {} } },
  { name: 'media_control', description: 'Control what is playing on this PC. Actions: play, pause, stop, next.', params: MEDIA },
  { name: 'set_timer', description: 'Start a countdown timer.', params: { type: 'object', properties: { minutes: { type: 'number' }, label: { type: 'string' } }, required: ['minutes'] } },
];
const window = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'pause the music' }];
const providerAnswering = (...answers) => { const asked = []; return { asked, constrain: async req => { asked.push(req); return answers.shift() ?? null; } }; };

test('validate: required, type, enum, extra arguments dropped, a tool with no parameters accepts none', () => {
  assert.deepEqual(validateArgs(MEDIA, { action: 'pause' }), { ok: true, args: { action: 'pause' }, problems: [] });
  assert.equal(validateArgs(MEDIA, {}).ok, false);
  assert.match(validateArgs(MEDIA, {}).problems.join(), /action is required/);
  assert.match(validateArgs(MEDIA, { action: 'explode' }).problems.join(), /action must be one of play, pause, stop, next/);
  assert.match(validateArgs(MEDIA, { action: 'play', volume: 'loud' }).problems.join(), /volume should be number/);
  assert.deepEqual(validateArgs(MEDIA, { action: 'play', color: 'red' }).args, { action: 'play' }, 'a made-up argument is dropped, not a failure');
  assert.equal(validateArgs(MEDIA, { action: 'play', color: 'red' }).ok, true);
  assert.equal(validateArgs(specs[0].params, undefined).ok, true);
  assert.equal(validateArgs(specs[0].params, null).ok, true);
  assert.equal(validateArgs(MEDIA, 'pause').ok, false);
  assert.equal(validateArgs({ type: 'object', properties: { n: { type: ['number', 'string'] } } }, { n: '5' }).ok, true);
  assert.equal(validateArgs({ type: 'object', properties: { l: { type: 'array', items: { type: 'string' } } } }, { l: [1] }).ok, false);
  assert.equal(firstSentence('Start a timer. It beeps when done.'), 'Start a timer');
});

test('repair: a valid call is left alone and costs no model call', async () => {
  const p = providerAnswering();
  assert.equal(await repairCall({ provider: p, window, call: { name: 'media_control', args: { action: 'pause' } }, specs }), null);
  assert.equal(p.asked.length, 0);
  assert.equal(await repairCall({ provider: p, window, call: { name: 'ytm_pause', args: {} }, specs, resolves: n => n === 'ytm_pause' }), null, 'a name the runner can already resolve is left to it');
  assert.equal(p.asked.length, 0);
  // only a made-up extra argument: tidied locally, still no model call
  const tidy = await repairCall({ provider: p, window, call: { name: 'media_control', args: { action: 'pause', color: 'red' } }, specs });
  assert.deepEqual(tidy, { name: 'media_control', args: { action: 'pause' }, how: ['tidy'] });
  assert.equal(p.asked.length, 0);
});

test('repair: an invented tool name is replaced by a real one chosen under a schema that only allows real names', async () => {
  const p = providerAnswering({ tool: 'media_control' }, { action: 'pause' });
  const logs = [];
  const r = await repairCall({ provider: p, window, call: { name: 'ytm_pause', args: {} }, specs, log: t => logs.push(t) });
  assert.deepEqual(r, { name: 'media_control', args: { action: 'pause' }, how: ['name', 'args'] });
  assert.deepEqual(p.asked[0].schema.properties.tool.enum, ['get_time', 'media_control', 'set_timer', 'none']);
  assert.match(p.asked[0].messages.at(-1).content, /ytm_pause.*not a tool/s);
  assert.match(p.asked[0].messages.at(-1).content, /- media_control: Control what is playing on this PC/);
  assert.deepEqual(p.asked[1].schema, MEDIA, 'the arguments are decoded under the tool\'s own schema');
  assert.equal(p.asked[0].messages[0].content, 'SYS', 'the conversation so far is kept');
  assert.match(logs[0], /Repaired tool call ytm_pause → media_control \(name \+ args\)/);
});

test('repair: "none", nonsense, or a name outside the list leaves the call as it was', async () => {
  for (const answer of [{ tool: 'none' }, { tool: 'nuke_everything' }, null, 'garbage', {}]) {
    assert.equal(await repairCall({ provider: providerAnswering(answer), window, call: { name: 'maximize_window', args: {} }, specs }), null, JSON.stringify(answer));
  }
});

test('repair: bad arguments of a real tool are decoded under its schema; a still-invalid answer is not trusted', async () => {
  const good = providerAnswering({ action: 'next' });
  assert.deepEqual(await repairCall({ provider: good, window, call: { name: 'media_control', args: { action: 'undefined' } }, specs }), { name: 'media_control', args: { action: 'next' }, how: ['args'] });
  assert.match(good.asked[0].messages.at(-1).content, /action must be one of/);
  const bad = providerAnswering({ action: 'still_wrong' });
  assert.equal(await repairCall({ provider: bad, window, call: { name: 'media_control', args: {} }, specs }), null);
  assert.equal(await repairCall({ provider: providerAnswering(null), window, call: { name: 'set_timer', args: {} }, specs }), null);
});

test('repair: a provider that cannot constrain, no tools in scope, or a provider that throws all leave the call alone', async () => {
  assert.equal(await repairCall({ provider: {}, window, call: { name: 'nope', args: {} }, specs }), null);
  assert.equal(await repairCall({ provider: providerAnswering({ tool: 'get_time' }), window, call: { name: 'nope', args: {} }, specs: [] }), null);
  const logs = [];
  assert.equal(await repairCall({ provider: { constrain: async () => { throw new Error('boom'); } }, window, call: { name: 'nope', args: {} }, specs, log: t => logs.push(t) }), null);
  assert.match(logs[0], /Tool repair failed.*boom/);
});

test('ollama provider: constrain sends the schema as format, decodes cold, and returns the object (or null)', async () => {
  const TAGS = { models: [{ name: 'm:latest', capabilities: ['completion', 'tools', 'thinking'], details: { parameter_size: '4B' } }] };
  const answers = [{ ok: true, json: async () => ({ message: { content: '{"tool":"media_control"}' } }) }, { ok: true, json: async () => ({ message: { content: 'not json' } }) }, { ok: false, status: 500, json: async () => ({}) }];
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, body: opts.body ? JSON.parse(opts.body) : null });
    if (p === '/api/tags') return { ok: true, json: async () => TAGS };
    if (p === '/api/ps') return { ok: true, json: async () => ({ models: [] }) };
    if (p === '/api/show') return { ok: true, json: async () => ({ parameters: 'num_ctx 8192', capabilities: ['tools', 'thinking'] }) };
    return answers.shift();
  };
  const p = createOllamaProvider({ getConfig: () => ({ ollama: { host: 'http://127.0.0.1:11434', model: 'm:latest', think: false } }), fetch });
  const schema = { type: 'object', properties: { tool: { type: 'string', enum: ['media_control', 'none'] } }, required: ['tool'] };
  assert.deepEqual(await p.constrain({ messages: [{ role: 'user', content: 'x' }], schema }), { tool: 'media_control' });
  const chat = calls.find(c => c.path === '/api/chat').body;
  assert.deepEqual(chat.format, schema);
  assert.equal(chat.stream, false);
  assert.equal(chat.think, false);
  assert.equal(chat.options.temperature, 0);
  assert.equal(chat.model, 'm:latest');
  assert.equal(await p.constrain({ messages: [], schema }), null, 'not JSON');
  assert.equal(await p.constrain({ messages: [], schema }), null, 'HTTP error');
  const down = createOllamaProvider({ getConfig: () => ({ ollama: { host: 'http://127.0.0.1:11434', model: 'm:latest' } }), fetch: async () => { throw new Error('down'); } });
  assert.equal(await down.constrain({ messages: [], schema }), null, 'Ollama not running');
});

function orchestratorWith(provider, tools, { constrainTools = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcon-'));
  const bus = createBus(), events = [];
  bus.on('*', e => events.push(e));
  const sessions = createSessionStore(dir);
  const providers = createRegistry(); providers.add(provider);
  const config = { provider: provider.id, constrainTools };
  const catalog = buildCatalog([{ id: 'core', label: 'Core', triggers: [], tools }]);
  const runner = createToolRunner(catalog.tools, { groups: catalog.groups });
  const orc = createOrchestrator({ bus, sessions, providers, tools: runner, getConfig: () => config, selectGroups: () => ['core'], systemPrompt: () => 'SYS', route: () => ({ tier: 'deep', think: false, tools: true }), timeoutMs: 5000 });
  return { orc, sessions, events };
}
const realTool = (name, schema, run) => ({ name, description: `${name} does its job for the user and says so.`, params: schema, run });

test('orchestrator: an invented tool name is repaired before it is shown or run, and the history keeps the real name', async () => {
  const ran = [];
  const tools = [realTool('get_time', { type: 'object', properties: {} }, async () => '10:00'), realTool('media_control', MEDIA, async a => { ran.push(a); return 'Paused.'; })];
  const fp = createFakeProvider([[{ type: 'tool_call', id: 'c1', name: 'ytm_pause', args: {} }, { type: 'done' }], [{ type: 'token', text: 'Done.' }, { type: 'done' }]],
    { constrain: async req => (req.schema.properties?.tool ? { tool: 'media_control' } : { action: 'pause' }) });
  const { orc, sessions, events } = orchestratorWith(fp, tools);
  const r = await orc.send(null, 'pause the music', { source: 'text' });
  assert.deepEqual(ran, [{ action: 'pause' }]);
  assert.equal(r.reply, 'Done.');
  const starts = events.filter(e => e.type === 'tool' && e.phase === 'start');
  assert.deepEqual(starts.map(e => e.name), ['media_control'], 'the chat shows the real tool');
  const s = sessions.load(r.sessionId);
  assert.equal(s.messages.find(m => m.toolCalls).toolCalls[0].name, 'media_control');
  assert.ok(events.some(e => e.type === 'log' && /Repaired tool call ytm_pause → media_control/.test(e.text)));
  assert.equal(fp.constrained.length, 2);
});

test('orchestrator: a valid call makes no extra model call; the switch turns repair off; a provider without constrain behaves as before', async () => {
  const tools = [realTool('get_time', { type: 'object', properties: {} }, async () => '10:00'), realTool('media_control', MEDIA, async () => 'Paused.')];
  const script = name => [[{ type: 'tool_call', id: 'c1', name, args: name === 'media_control' ? { action: 'pause' } : {} }, { type: 'done' }], [{ type: 'token', text: 'ok' }, { type: 'done' }]];
  const ok = createFakeProvider(script('media_control'), { constrain: async () => { throw new Error('should not be asked'); } });
  await orchestratorWith(ok, tools).orc.send(null, 'pause', { source: 'text' });
  assert.equal(ok.constrained.length, 0);

  const off = createFakeProvider(script('ytm_pause'), { constrain: async () => ({ tool: 'media_control' }) });
  const o = orchestratorWith(off, tools, { constrainTools: false });
  await o.orc.send(null, 'pause', { source: 'text' });
  assert.equal(off.constrained.length, 0, 'switched off');
  assert.ok(o.events.some(e => e.type === 'tool' && e.phase === 'end' && e.ok === false) || o.events.some(e => e.type === 'tool' && e.name === 'ytm_pause'));

  const plain = createFakeProvider(script('maximize_window'));   // no constrain(): the old error path
  const pr = orchestratorWith(plain, tools);
  const r = await pr.orc.send(null, 'x', { source: 'text' });
  assert.equal(typeof r.reply, 'string');
  assert.deepEqual(pr.events.filter(e => e.type === 'tool' && e.phase === 'start').map(e => e.name), ['maximize_window']);
});
