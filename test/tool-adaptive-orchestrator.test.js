// The adaptive loop wired into the turn: round status notes, rediscovery, exclusion, need-a-tool, scaled budgets,
// deliberate repeats. intelligence:false must keep the old loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { createToolIndex } = require('../src/core/skills/toolindex');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner, eligibility } = require('../src/core/tools/registry');
const { createLedger } = require('../src/core/tools/ledger');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

const say = text => [{ type: 'token', text }, { type: 'done' }];
const call = (name, args = {}, id = 'c1') => [{ type: 'tool_call', id, name, args }, { type: 'done' }];
const P = { type: 'object', properties: { q: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' }, n: { type: 'number' } } };

function setup(script, { constrain, route, intelligence, provider, extra, resolve } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-adapt-'));
  const ran = [];
  const mk = (name, description, sideEffects, out) => ({ name, description, params: P, sideEffects, async run(a) { ran.push(name); return typeof out === 'function' ? out(a) : out; } });
  const groups = [
    { id: 'core', label: 'Core', triggers: [], tools: [mk('get_time', 'Tell the time.', 'read', 'NOON')] },
    { id: 'files', label: 'Files', triggers: [{ words: ['files'], w: 3 }], tools: [{ ...mk('search_files', 'Search files by name.', 'read', ''), ...(extra ? { untrusted: true } : {}) }] },   // extra: the read taints the turn
    { id: 'notes', label: 'Notes', triggers: [], tools: [mk('search_notes', 'Search notes and budget memos.', 'read', 'note: budget draft'), ...(extra ? [{ ...mk('delete_notes', 'Delete notes and budget memos.', 'write', 'deleted'), risk: 'confirm' }] : [])] },
    { id: 'rivals', label: 'Rivals', triggers: [], tools: [mk('send_email', 'Send a text to someone.', 'write', 'sent'), mk('send_sms', 'Send a text to someone.', 'write', 'sent')] },
    { id: 'browse', label: 'Browser', triggers: [{ words: ['browser'], w: 3 }], tools: [mk('browser_open', 'Open a page in the browser.', 'read', () => { throw new Error('the Chrome extension is not connected'); }), mk('browser_text', 'Read the browser page text.', 'read', 'page text')] },
    { id: 'comms', label: 'Messages', triggers: [{ words: ['message', 'send'], w: 3 }], tools: [mk('send_message', 'Send a message to someone.', 'write', 'sent')] },
    { id: 'media', label: 'Media', triggers: [{ words: ['music', 'pause', 'play'], w: 3 }], tools: [mk('media_control', 'Pause or play the music.', 'write', 'done')] },
  ];
  const catalog = buildCatalog(groups);
  const c = { ran, embeds: 0, catalog };
  c.fp = provider || createFakeProvider(script, { constrain: constrain || (async () => ({ kind: 'new', groups: [], confidence: 0.9 })) });
  c.bus = createBus();
  const providers = createRegistry(); providers.add(NullProvider); providers.add(c.fp);
  c.sessions = createSessionStore(dir);
  const toolIndex = createToolIndex({ catalog, embed: null, embedMs: 50, eligible: eligibility });
  c.orc = createOrchestrator({
    bus: c.bus, sessions: c.sessions, providers, tools: createToolRunner(groups.flatMap(g => g.tools), { groups, toolIndex }), catalog, toolIndex, ledger: createLedger({}),
    intelligence, ...(resolve ? { resolveSelection: resolve } : {}), getConfig: () => ({ ...DEFAULTS, provider: c.fp.id }),
    selectGroups: (t, o) => selectGroups(t, o, catalog),
    route: route || (() => ({ tier: 'deep', think: false, tools: true, steps: 2, reason: 'test' })),
  });
  c.s = c.sessions.create(); c.sessions.save(c.s);
  c.offered = n => (c.fp.calls[n].tools || []).map(t => t.name);
  c.lastUser = n => c.fp.calls[n].messages.at(-1).content;
  c.tools = () => c.sessions.load(c.s.id).messages.filter(m => m.role === 'tool').map(m => m.content);
  c.done = () => fs.rmSync(dir, { recursive: true, force: true });
  return c;
}

test('an empty result brings a status note and rediscovery; the same signal twice ends the turn', async () => {
  const c = setup([call('search_files', { q: 'budget' }), call('search_files', { q: 'budget 2' }, 'c2'), say('Nothing found.')]);
  const r = await c.orc.send(c.s.id, 'find the budget in my files notes');
  assert.ok(!c.offered(0).includes('search_notes'), 'not offered before: ' + c.offered(0));
  assert.match(c.lastUser(1), /^search_files found nothing\. Try other words/);
  assert.ok(c.offered(1).includes('search_notes'), 'rediscovered: ' + c.offered(1));
  assert.equal(c.fp.calls.length, 3);
  assert.equal(c.fp.calls[2].tools, undefined);
  assert.equal(r.reply, 'Nothing found.');
  assert.equal(r.error, undefined);
  assert.ok(c.fp.constrained.filter(q => q.schema?.properties?.groups).length <= 1);
  c.done();
});

test('a tool that is unavailable is excluded from the next call', async () => {
  const c = setup([call('browser_open', { q: 'x' }), say('The browser is not connected.')]);
  await c.orc.send(c.s.id, 'open this in the browser');
  assert.ok(c.offered(0).includes('browser_open'));
  assert.ok(!c.offered(1).includes('browser_open'), c.offered(1).join());
  c.done();
});

test('confident chat: no tools, one model call', async () => {
  const c = setup([say('Hello there.')], { constrain: async () => ({ kind: 'chat', groups: [], confidence: 0.9 }) });
  await c.orc.send(c.s.id, 'hello how are you doing today my friend');
  assert.equal(c.fp.calls[0].tools, undefined);
  assert.equal(c.fp.calls.length, 1);
  assert.ok(c.fp.constrained.length <= 1);
  c.done();
});

test('a simple command stays model-free and embed-free', async () => {
  const c = setup([call('media_control', { q: 'pause' }), say('Paused.')]);
  await c.orc.send(c.s.id, 'pause the music');
  assert.equal(c.fp.constrained.length, 0);
  assert.equal(c.embeds, 0);
  assert.ok(c.fp.calls.length <= 2);
  c.done();
});

test('deliberate repeat: "send it again" runs the write again, once per turn; no repeat words stays Already done; model force is ignored', async () => {
  const args = { to: 'mum', text: 'hi' };
  const comms = async () => ({ kind: 'new', groups: ['comms'], confidence: 0.9 });
  let c = setup([call('send_message', args), say('Sent.'), call('send_message', args), call('send_message', args, 'c2'), say('Sent again.')], { constrain: comms });
  await c.orc.send(c.s.id, 'send a message to mum');
  await c.orc.send(c.s.id, 'send it again');
  assert.equal(c.ran.filter(n => n === 'send_message').length, 2);
  assert.match(c.tools().at(-1), /^Already done/);
  c.done();

  c = setup([call('send_message', args), say('Sent.'), call('send_message', { ...args, force: true }), say('Done.')], { constrain: comms });
  await c.orc.send(c.s.id, 'send a message to mum');
  await c.orc.send(c.s.id, 'send a message to mum');
  assert.equal(c.ran.filter(n => n === 'send_message').length, 1);
  assert.match(c.tools().at(-1), /^Already done/);
  c.done();
});

function loopProvider() {
  const calls = [];
  return {
    id: 'loop', label: 'Loop', capabilities: { tools: true }, calls,
    async status() { return { ready: true }; },
    async *chat({ tools, messages }) {
      calls.push({ tools, messages });
      if (tools?.length) yield { type: 'tool_call', id: 'c' + calls.length, name: 'get_time', args: { n: calls.length } };
      else yield { type: 'token', text: 'Done.' };
      yield { type: 'done' };
    },
  };
}

test('budget: a single-step turn gets 3 rounds then answers; intelligence:false keeps 5', async () => {
  const route = () => ({ tier: 'deep', think: false, tools: true, steps: 1, reason: 'test' });
  let c = setup(null, { provider: loopProvider(), route });
  let r = await c.orc.send(c.s.id, 'tell me the time');
  assert.equal(c.ran.length, 3);
  assert.equal(r.reply, 'Done.');
  assert.equal(r.error, undefined);
  c.done();

  c = setup(null, { provider: loopProvider(), route, intelligence: false });
  r = await c.orc.send(c.s.id, 'tell me the time');
  assert.equal(c.ran.length, 5);
  assert.equal(r.reply, 'Done.');
  c.done();
});

test('intelligence:false reproduces the old loop: no status note, no force', async () => {
  const c = setup([call('search_files', { q: 'budget' }), say('Nothing.')], { intelligence: false });
  await c.orc.send(c.s.id, 'find the budget in my files notes');
  assert.doesNotMatch(c.lastUser(1), /found nothing/);
  c.done();
});

// -- review round 1 ------------------------------------------------------------
function withUsage(usage) {
  const p = loopProvider();
  const chat = p.chat;
  p.status = async () => ({ ready: true, contextMax: 10000 });
  p.chat = async function* (a) { for await (const c of chat(a)) yield c.type === 'done' ? { ...c, usage } : c; };
  return p;
}

test('the token cap forces the answer round', async () => {
  const route = () => ({ tier: 'deep', think: false, tools: true, steps: 3, reason: 'test' });
  const c = setup(null, { provider: withUsage({ promptTokens: 9000, completionTokens: 10 }), route });
  const r = await c.orc.send(c.s.id, 'tell me the time');
  assert.equal(c.ran.length, 1);
  assert.equal(r.reply, 'Done.');
  assert.equal(r.error, undefined);
  const d = setup(null, { provider: withUsage({ promptTokens: 100, completionTokens: 10 }), route });
  await d.orc.send(d.s.id, 'tell me the time');
  assert.equal(d.ran.length, 7);
  c.done(); d.done();
});

test('confident chat that claims an action is still redone with tools', async () => {
  const c = setup([say('I have sent the message to mum.'), call('send_message', { to: 'mum', text: 'hi' }), say('Sent.')], { constrain: async () => ({ kind: 'chat', groups: [], confidence: 0.9 }) });
  const r = await c.orc.send(c.s.id, 'hello how are you doing today my friend');
  assert.equal(c.fp.calls[0].tools, undefined);
  assert.ok(c.fp.calls[1].tools?.length, 'redone with tools');
  assert.equal(c.ran.filter(n => n === 'send_message').length, 1);
  assert.equal(r.reply, 'Sent.');
  c.done();
});

test('rediscovery on a tainted turn never offers a confirm tool', async () => {
  const c = setup([call('search_files', { q: 'budget' }), say('Nothing.')], { extra: true });
  await c.orc.send(c.s.id, 'find the budget in my files notes');
  assert.ok(c.offered(1).includes('search_notes'), c.offered(1).join());
  assert.ok(!c.offered(1).includes('delete_notes'), c.offered(1).join());
  c.done();
});

test('toolIndex hides confirm tools from a tainted or guest caller', async () => {
  const c = setup([say('x')], { extra: true });
  const idx = createToolIndex({ catalog: c.catalog, embed: null, eligible: eligibility });
  const own = await idx.find('delete budget notes', { groups: null });
  assert.ok(own.tools.some(t => t.name === 'delete_notes'), 'the owner may be offered it');
  for (const opts of [{ tainted: true }, { speaker: 'guest', tainted: true }]) {
    const r = await idx.find('delete budget notes', { groups: null, ...opts });
    assert.ok(!r.tools.some(t => t.name === 'delete_notes'), JSON.stringify(opts));
  }
  c.done();
});

test('disambiguation: a tie and no earlier model call costs exactly one constrain call; a high-confidence turn none', async () => {
  const withConf = (arr, conf) => { Object.defineProperty(arr, 'confidence', { value: conf, enumerable: false }); return arr; };
  for (const [conf, want, hidden] of [['medium', 1, 'send_email'], ['high', 0, null]]) {
    const c = setup([say('Which one?')], { constrain: async () => ({ tool: 'send_sms' }), resolve: async () => ({ action: 'act', groups: withConf(['core', 'rivals'], conf), source: 'rule' }) });
    await c.orc.send(c.s.id, 'send a text to mum');
    assert.equal(c.fp.constrained.length, want, conf);
    if (hidden) assert.ok(!c.offered(0).includes(hidden) && c.offered(0).includes('send_sms'), c.offered(0).join());
    c.done();
  }
});

test('intelligence:false is the old loop: no notes, no rediscovery, no stop, no force, no budget scaling', async () => {
  const empty = [call('search_files', { q: 'a' }), call('search_files', { q: 'b' }, 'c2'), call('search_files', { q: 'c' }, 'c3'), say('Nothing.')];
  const c = setup(empty, { intelligence: false });
  const r = await c.orc.send(c.s.id, 'find the budget in my files notes');
  assert.equal(r.reply, 'Nothing.');
  assert.equal(c.fp.calls.length, 4);
  for (let i = 1; i < 4; i++) {
    assert.doesNotMatch(c.lastUser(i), /found nothing/);
    assert.ok(c.fp.calls[i].tools?.length && !c.offered(i).includes('search_notes'), 'same tools every round');
  }
  c.done();
  const args = { to: 'mum', text: 'hi' };
  const comms = async () => ({ kind: 'new', groups: ['comms'], confidence: 0.9 });
  const d = setup([call('send_message', args), say('Sent.'), call('send_message', args), say('ok')], { constrain: comms, intelligence: false });
  await d.orc.send(d.s.id, 'send a message to mum');
  await d.orc.send(d.s.id, 'send it again');
  assert.equal(d.ran.filter(n => n === 'send_message').length, 1);   // force stays false: the ledger answers
  d.done();
});
