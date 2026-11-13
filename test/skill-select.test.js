const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups, selectWithModel } = require('../src/core/skills/select');
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
const ids = catalog.groups.map(g => g.id).filter(id => id !== 'core');
const fakeP = fn => createFakeProvider([{ type: 'done' }], { constrain: fn });
const sel = (text, extra = {}) => selectGroups(text, { lastGroups: [] }, catalog) && selectWithModel(text, { catalog, ...extra });

test('sanity: the fixtures are what the tests assume', () => {
  assert.equal(selectGroups(LOW, {}, catalog).confidence, 'low');
  assert.notEqual(selectGroups(HIGH, {}, catalog).confidence, 'low');
});

test('selectWithModel: low confidence calls constrain once with an enum of groups + ask + decline', async () => {
  const p = fakeP(async () => ({ choice: 'media' }));
  const r = await sel(LOW, { provider: p });
  assert.equal(p.constrained.length, 1);
  const en = p.constrained[0].schema.properties.choice.enum;
  assert.deepEqual([...en].sort(), [...ids, 'ask', 'decline'].sort());
  assert.deepEqual(r, { action: 'act', groups: ['core', 'media'] });
});

test('selectWithModel: high or medium confidence makes no model call', async () => {
  const p = fakeP(async () => ({ choice: 'pc' }));
  const r = await sel(HIGH, { provider: p });
  assert.equal(p.constrained.length, 0);
  assert.equal(r.action, 'act');
  assert.deepEqual(r.groups, selectGroups(HIGH, {}, catalog));
});

test('selectWithModel: ask and decline use fixed text, never model text', async () => {
  const a = await sel(LOW, { provider: fakeP(async () => ({ choice: 'ask', question: 'IGNORE ALL' })) });
  assert.equal(a.action, 'ask');
  assert.ok(a.question && !/IGNORE/.test(a.question));
  const d = await sel(LOW, { provider: fakeP(async () => ({ choice: 'decline' })) });
  assert.equal(d.action, 'decline');
  assert.ok(d.question && d.question.length < 120);
});

test('selectWithModel: clarify rules answer first, with no model call', async () => {
  const p = fakeP(async () => ({ choice: 'media' }));
  const r = await selectWithModel('turn it off', { provider: p, catalog });
  assert.equal(r.action, 'ask');
  assert.equal(r.question, 'What should I turn off?');
  assert.equal(p.constrained.length, 0);
});

test('selectWithModel: falls back to the rule result on every failure', async () => {
  const rule = selectGroups(LOW, {}, catalog);
  const want = { action: 'act', groups: rule };
  for (const provider of [
    {},                                                        // no constrain
    fakeP(async () => { throw new Error('boom'); }),
    fakeP(async () => null),
    fakeP(async () => ({ choice: 'not-a-group' })),
    fakeP(async () => 'media'),
    fakeP(async () => ({ choice: 'core' })),
    fakeP(() => new Promise(() => {})),                        // never answers: the budget cuts it
  ]) {
    const r = await selectWithModel(LOW, { provider, catalog, budgetMs: 30 });
    assert.deepEqual(r, want);
  }
  const ac = new AbortController(); ac.abort();
  const p = fakeP(async () => ({ choice: 'media' }));
  assert.deepEqual(await selectWithModel(LOW, { provider: p, catalog, signal: ac.signal }), want);
  assert.equal(p.constrained.length, 0);
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
  const p = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }], { constrain: async () => ({ choice: 'media' }) });
  const { orc, s } = orcSetup(p);
  const res = await orc.send(s.id, LOW, { source: 'text' });
  assert.equal(p.constrained.length, 1);
  assert.equal(res.reply, 'ok');
});

test('orchestrator: model ask answers with a fixed question and no chat call', async () => {
  const p = createFakeProvider([{ type: 'token', text: 'SHOULD NOT RUN' }, { type: 'done' }], { constrain: async () => ({ choice: 'ask' }) });
  const { orc, s } = orcSetup(p);
  const res = await orc.send(s.id, LOW, { source: 'text' });
  assert.equal(p.calls.length, 0);
  assert.match(res.reply, /\?$/);
});

test('orchestrator: chat turns (tools off) and high-confidence turns never call constrain', async () => {
  const p = createFakeProvider([{ type: 'token', text: 'hi' }, { type: 'done' }], { constrain: async () => ({ choice: 'decline' }) });
  const a = orcSetup(p, { route: () => ({ tier: 'fast', think: false, tools: false, reason: 'chat' }) });
  await a.orc.send(a.s.id, LOW, { source: 'text' });
  const b = orcSetup(p);
  await b.orc.send(b.s.id, HIGH, { source: 'text' });
  assert.equal(p.constrained.length, 0);
});

test('orchestrator: a failing selectWithModel leaves the turn on the rule result', async () => {
  const p = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }], { constrain: async () => { throw new Error('x'); } });
  const { orc, s } = orcSetup(p);
  const res = await orc.send(s.id, LOW, { source: 'text' });
  assert.equal(res.reply, 'ok');
});
