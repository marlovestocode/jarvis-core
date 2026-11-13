const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { toolDeps } = require('./helpers/tool-deps');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

const catalog = buildCatalog(loadGroups(toolDeps()));
const LOW = 'sort of get that going for me';       // matches nothing: low confidence
const HIGH = 'pause the music';                    // clear match

test('sanity: the fixtures are what the tests assume', () => {
  assert.equal(selectGroups(LOW, {}, catalog).confidence, 'low');
  assert.notEqual(selectGroups(HIGH, {}, catalog).confidence, 'low');
});

function orcSetup(provider, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-sel-'));
  const bus = createBus();
  const events = [];
  bus.on('*', ev => events.push(ev));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(provider);
  const seen = [];
  const tools = createToolRunner([]);
  const realTurn = tools.turn;
  const orc = createOrchestrator({
    bus, sessions, providers, tools, getConfig: () => ({ ...DEFAULTS, provider: provider.id }), catalog,
    selectGroups: (t, o) => selectGroups(t, o, catalog),
    route: () => ({ tier: 'deep', think: false, tools: true, reason: 'test' }),
    ...opts,
  });
  const s = sessions.create(); sessions.save(s);
  return { orc, s, events, seen, sessions };
}

test('orchestrator: a low-confidence turn is decided by the model (act narrows the groups)', async () => {
  const p = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }], { constrain: async () => ({ kind: 'new', groups: ['media'], confidence: 0.9 }) });
  const { orc, s } = orcSetup(p, { tools: createToolRunner(catalog.tools, { groups: catalog.groups }) });
  const res = await orc.send(s.id, LOW, { source: 'text' });
  assert.equal(p.constrained.length, 1);
  assert.equal(res.reply, 'ok');
  const offered = p.calls[0].tools.map(t => t.name);
  const media = catalog.groups.find(g => g.id === 'media').tools.map(t => t.name);
  const knowledge = catalog.groups.find(g => g.id === 'knowledge').tools.map(t => t.name);
  assert.ok(media.every(n => offered.includes(n)), 'the model pick (media) is offered');
  assert.ok(!knowledge.some(n => offered.includes(n) && !media.includes(n)), 'the rule fallback (knowledge) is not');
});

test('orchestrator: model ask answers with its question and no chat call', async () => {
  const p = createFakeProvider([{ type: 'token', text: 'SHOULD NOT RUN' }, { type: 'done' }], { constrain: async () => ({ kind: 'new', groups: [], confidence: 0.2, ask: 'Which thing should I start?' }) });
  const { orc, s } = orcSetup(p);
  const res = await orc.send(s.id, LOW, { source: 'text' });
  assert.equal(p.calls.length, 0);
  assert.equal(res.reply, 'Which thing should I start?');
});

test('orchestrator: chat turns (tools off) and high-confidence turns never call constrain', async () => {
  const p = createFakeProvider([{ type: 'token', text: 'hi' }, { type: 'done' }], { constrain: async () => ({ choice: 'decline' }) });
  const a = orcSetup(p, { route: () => ({ tier: 'fast', think: false, tools: false, reason: 'chat' }) });
  await a.orc.send(a.s.id, LOW, { source: 'text' });
  const b = orcSetup(p);
  await b.orc.send(b.s.id, HIGH, { source: 'text' });
  assert.equal(p.constrained.length, 0);
});

test('orchestrator: a failing interpreter leaves the turn on the rule result', async () => {
  const p = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }], { constrain: async () => { throw new Error('x'); } });
  const { orc, s } = orcSetup(p);
  const res = await orc.send(s.id, LOW, { source: 'text' });
  assert.equal(res.reply, 'ok');
});
