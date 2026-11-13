'use strict';
// Adaptive routing through the real orchestrator: real tool runner with skill groups, a scripted provider,
// and a stub live state whose snapshot is the fixture under test (src/core/brain/plan.js wired in).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { buildCatalog } = require('../src/core/skills');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

const call = (id, name, args = {}) => [{ type: 'tool_call', id, name, args }, { type: 'done' }];
const say = text => [{ type: 'token', text }, { type: 'done' }];
const chatRoute = () => ({ tier: 'fast', think: false, tools: false, reason: 'chat' });
const toolRoute = () => ({ tier: 'deep', think: false, tools: true, reason: 'tools', depth: 1, steps: 1 });
const P = { type: 'object', properties: {} };

function groups(ran) {
  const tool = name => ({ name, description: `The ${name} tool.`, params: P, async run() { ran.push(name); return `${name} result`; } });
  return [
    { id: 'core', label: 'Core', triggers: [], tools: [tool('now_time')] },
    { id: 'web', label: 'Web', triggers: [], tools: [tool('web_search'), tool('read_page')] },
    { id: 'solo', label: 'Solo', triggers: [], tools: [tool('only_tool')] },
  ];
}

function setup(script, { live, route = toolRoute, selectGroups = () => ['core', 'web'], catalog, resolveModel, timeoutMs } = {}) {
  const ran = [];
  const gs = groups(ran);
  const runner = createToolRunner(gs.flatMap(g => g.tools), { groups: gs });
  const fp = createFakeProvider(script);
  if (resolveModel) fp.resolveModel = resolveModel;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-routing-'));
  const bus = createBus();
  const events = [];
  bus.on('*', ev => events.push(ev));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(fp);
  const turned = [];
  const tools = Object.assign(Object.create(runner), { turn: g => { turned.push(g); return runner.turn(g); } });
  const orc = createOrchestrator({
    bus, sessions, providers, tools, getConfig: () => ({ ...DEFAULTS, provider: fp.id }),
    route, selectGroups, live, catalog: catalog === undefined ? buildCatalog(gs) : catalog, ...(timeoutMs ? { timeoutMs } : {}),
  });
  const s = sessions.create(); sessions.save(s);
  return { fp, events, orc, s, ran, runner, turned };
}
const specNames = c => (c.tools || []).map(t => t.name);
const routeEvents = events => events.filter(e => e.type === 'route').map(({ t, ...e }) => e);
const warns = events => events.filter(e => e.type === 'log' && e.level === 'warn');
const failed = (name, now, n = 2) => Array.from({ length: n }, (_, i) => ({ name, ok: false, soft: false, t: now - 1000 * (i + 1) }));

test('routing: without live a plain turn offers the same tools and route event as today', async () => {
  const { fp, events, orc, s } = setup([say('Here you go.')]);
  const res = await orc.send(s.id, 'search the web for cats');
  assert.equal(res.reply, 'Here you go.');
  assert.deepEqual(specNames(fp.calls[0]), ['now_time', 'web_search', 'read_page']);
  assert.deepEqual(routeEvents(events).map(({ type, ...e }) => e), [{ tier: 'deep', think: false, reason: 'tools', model: null }]);
  assert.ok(!events.some(e => e.type === 'modelfail'));
  // a live state with nothing in it changes nothing
  const t = Date.now();
  const b = setup([say('Here you go.')], { live: { snapshot: () => ({ t, tools: [], models: [] }) } });
  await b.orc.send(b.s.id, 'search the web for cats');
  assert.deepEqual(specNames(b.fp.calls[0]), specNames(fp.calls[0]));
  assert.deepEqual(routeEvents(b.events).map(({ type, ...e }) => e), routeEvents(events).map(({ type, ...e }) => e));
});

test('routing: a cooling tool is not offered while another remains, but still runs when called by name', async () => {
  const t = Date.now();
  const { fp, events, orc, s, ran } = setup([call('c1', 'web_search'), say('Here you go.')], { live: { snapshot: () => ({ t, tools: failed('web_search', t), models: [] }) } });
  const res = await orc.send(s.id, 'search the web for cats');
  assert.equal(res.reply, 'Here you go.');
  const offered = specNames(fp.calls[0]);
  assert.ok(!offered.includes('web_search'));
  assert.ok(offered.includes('read_page'));
  assert.deepEqual(ran, ['web_search']);
  assert.ok(events.some(e => e.type === 'tool' && e.name === 'web_search' && e.phase === 'end' && e.ok === true));
  assert.match(routeEvents(events)[0].reason, /cooldown: web_search/);
});

test('routing: the only tool in scope stays offered while cooling, and so do all when every one cools', async () => {
  const t = Date.now();
  const a = setup([say('Okay.')], { selectGroups: () => ['solo'], live: { snapshot: () => ({ t, tools: failed('only_tool', t), models: [] }) } });
  await a.orc.send(a.s.id, 'use the only tool');
  assert.deepEqual(specNames(a.fp.calls[0]), ['only_tool']);
  const all = [...failed('now_time', t), ...failed('web_search', t), ...failed('read_page', t)];
  const b = setup([say('Okay.')], { live: { snapshot: () => ({ t, tools: all, models: [] }) } });
  await b.orc.send(b.s.id, 'search the web for cats');
  assert.deepEqual(specNames(b.fp.calls[0]), ['now_time', 'web_search', 'read_page']);
});

test('routing: a failing model call emits modelfail, and a later snapshot listing it twice avoids it', async () => {
  const t = Date.now();
  let snap = { t, tools: [], models: [] };
  const asked = [];
  const resolveModel = h => { asked.push(h); return h.avoid === 'main-model' ? 'other-model' : 'main-model'; };
  const { events, orc, s } = setup([[{ type: 'throw', message: 'HTTP 500' }], say('Recovered.'), say('Second.')], { live: { snapshot: () => snap }, resolveModel });
  const r1 = await orc.send(s.id, 'search the web for cats');
  assert.equal(r1.reply, 'Recovered.');
  const fails = events.filter(e => e.type === 'modelfail');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].model, 'main-model');
  assert.deepEqual(Object.keys(fails[0]).filter(k => k !== 'type' && k !== 't'), ['model']);
  snap = { t, tools: [], models: [{ name: 'main-model', t: t - 2000 }, { name: 'main-model', t: t - 1000 }] };
  asked.length = 0;
  const r2 = await orc.send(s.id, 'search the web for dogs');
  assert.equal(r2.reply, 'Second.');
  assert.equal(asked[0].avoid, 'main-model');
  assert.equal(routeEvents(events).at(-1).model, 'other-model');
});

test('routing: a stop or a timeout is not a model failure', async () => {
  const resolveModel = () => 'main-model';
  const live = { snapshot: () => ({ t: Date.now(), tools: [], models: [] }) };
  const a = setup([{ type: 'hang' }], { live, resolveModel });
  const p = a.orc.send(a.s.id, 'search the web for cats');
  setTimeout(() => a.orc.stop(), 20);
  const ra = await p;
  assert.equal(ra.stopped, true);
  assert.ok(!a.events.some(e => e.type === 'modelfail'));
  const b = setup([{ type: 'hang' }], { live, resolveModel, timeoutMs: 30 });
  const rb = await b.orc.send(b.s.id, 'search the web for cats');
  assert.equal(rb.error, 'Model timed out');
  assert.ok(!b.events.some(e => e.type === 'modelfail'));
});

test('routing: a pending confirm turns a chat-like message into a tools turn with its group', async () => {
  const t = Date.now();
  const { fp, events, orc, s, turned } = setup([say('Still waiting on your yes.')], {
    route: chatRoute, selectGroups: () => ['core'],
    live: { snapshot: () => ({ t, tools: [], models: [], confirm: { summary: 'Delete movie.mkv', group: 'web' } }) },
  });
  await orc.send(s.id, 'thanks');
  assert.equal(fp.calls[0].hints.tools, true);
  assert.match(routeEvents(events)[0].reason, /confirm pending/);
  assert.deepEqual(turned[0], ['core', 'web']);
  assert.ok(specNames(fp.calls[0]).includes('web_search'));
});

test('routing: a continue follow-up seeds the groups and forces tools, as the inline code did', async () => {
  const t = Date.now();
  const seen = [];
  const { fp, events, orc, s, turned } = setup([say('Okay.')], {
    route: chatRoute, selectGroups: (x, o) => { seen.push(o.lastGroups); return ['core']; },
    live: { snapshot: () => ({ t, tools: [{ name: 'web_search', ok: true, soft: false, t }], models: [], groups: { list: ['web'], at: t }, media: null, confirm: null }) },
  });
  await orc.send(s.id, 'do it again');
  assert.ok(events.some(e => e.type === 'followup' && e.kind === 'continue'));
  assert.deepEqual(seen, [['web']]);
  assert.deepEqual(turned[0], ['web']);
  assert.equal(fp.calls[0].hints.tools, true);
  assert.equal(fp.calls[0].hints.tier, 'deep');
  assert.equal(fp.calls[0].hints.reason, 'follow-up');
  assert.equal(routeEvents(events)[0].reason, 'follow-up');
});

test('routing: plan() throwing logs one warning and the turn runs on the plain route', async () => {
  const t = Date.now();
  const badCatalog = { get ids() { throw new Error('bad catalog'); } };
  const a = setup([say('Okay.')], { route: chatRoute, selectGroups: () => ['core'], catalog: badCatalog,
    live: { snapshot: () => ({ t, tools: [], models: [], confirm: { summary: 'Delete movie.mkv', group: 'web' } }) } });
  const ra = await a.orc.send(a.s.id, 'thanks');
  assert.equal(ra.reply, 'Okay.');
  assert.equal(warns(a.events).length, 1);
  assert.match(warns(a.events)[0].text, /bad catalog/);
  assert.equal(a.fp.calls[0].hints.tools, false);
  assert.equal(routeEvents(a.events)[0].reason, 'chat');
  // a snapshot whose fields throw on read: follow-up resolution swallows it, plan() does not, the turn still runs
  const snap = { t, tools: [], models: [] };
  Object.defineProperty(snap, 'confirm', { enumerable: true, get() { throw new Error('bad snapshot'); } });
  const b = setup([say('Okay.')], { route: chatRoute, selectGroups: () => ['core'], live: { snapshot: () => snap } });
  const rb = await b.orc.send(b.s.id, 'thanks');
  assert.equal(rb.reply, 'Okay.');
  assert.equal(warns(b.events).length, 1);
  assert.match(warns(b.events)[0].text, /bad snapshot/);
  assert.deepEqual(specNames(b.fp.calls[0]), []);
});

test('routing: a task step (tools.run direct) of a cooling tool still runs', async () => {
  const t = Date.now();
  const { orc, s, ran, runner } = setup([say('Okay.')], { live: { snapshot: () => ({ t, tools: failed('web_search', t), models: [] }) } });
  await orc.send(s.id, 'search the web for cats');
  const res = await runner.run('web_search', {}, { turn: { source: 'task', tainted: false } });
  assert.equal(res.ok, true);
  assert.deepEqual(ran, ['web_search']);
});
