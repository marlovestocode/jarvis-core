const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { createToolRunner } = require('../src/core/tools/registry');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');
const { toolDeps } = require('./helpers/tool-deps');

function setup(deps = toolDeps()) {
  const catalog = buildCatalog(loadGroups(deps));
  const runner = createToolRunner(catalog.tools, { groups: catalog.groups });
  return { deps, catalog, runner, ctx: { turn: { tainted: false } } };
}
const names = scope => scope.specs().map(s => s.name);

test('turn: specs only for loaded groups', () => {
  const { runner, catalog } = setup();
  const n = names(runner.turn(['core', 'math']));
  assert.ok(n.includes('get_time') && n.includes('more_skills') && n.includes('calculate'));
  assert.ok(!n.includes('open_app') && !n.includes('get_weather'));
  assert.ok(n.length < catalog.tools.length);
  assert.deepEqual(runner.turn(['core', 'math']).loaded(), ['core', 'math']);
});

test('turn: more_skills adds a group for the rest of the turn', async () => {
  const { runner, ctx } = setup();
  const scope = runner.turn(['core']);
  assert.ok(!names(scope).includes('calculate'));
  const r = await scope.run('more_skills', { group: 'math' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.text, /^Loaded Math.*: .*calculate/);
  assert.ok(names(scope).includes('calculate'));
  assert.deepEqual(scope.loaded(), ['core', 'math']);
  assert.ok(!names(runner.turn(['core'])).includes('calculate'), 'a new turn starts clean');
});

test('turn: unknown group returns the group ids', async () => {
  const { runner, ctx } = setup();
  const r = await runner.turn(['core']).run('more_skills', { group: 'bananas' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.text, /Unknown group\. Groups: core, media, .*math, memory\./);
});

test('turn: wrong case and aliases load the group, reloading a loaded group costs nothing', async () => {
  const { runner, ctx } = setup();
  const scope = runner.turn(['core']);
  assert.equal((await scope.run('more_skills', { group: 'MATH' }, ctx)).ok, true);
  assert.equal((await scope.run('more_skills', { group: 'weather' }, ctx)).ok, true);   // a tool alias → knowledge
  assert.deepEqual(scope.loaded(), ['core', 'math', 'knowledge']);
  assert.equal((await scope.run('more_skills', { group: 'Math' }, ctx)).ok, true);
  assert.equal((await scope.run('more_skills', { group: 'core' }, ctx)).ok, true);
  assert.equal((await scope.run('more_skills', { group: 'pc' }, ctx)).ok, false, 'a third new group is over the cap');
  assert.deepEqual(scope.loaded(), ['core', 'math', 'knowledge']);
});

test('turn: third extra load is refused with a message and runs nothing', async () => {
  const { runner, ctx, deps } = setup();
  const scope = runner.turn(['core']);
  await scope.run('more_skills', { group: 'math' }, ctx);
  await scope.run('more_skills', { group: 'timers' }, ctx);
  const r = await scope.run('list_windows', {}, ctx);   // pc is not loaded and the cap is used up
  assert.equal(r.ok, false);
  assert.match(r.text, /Cannot load more skills this turn \(limit 2\)\. Answer with what you have\./);
  assert.deepEqual(deps.pc.host.calls, []);
  assert.ok(!scope.loaded().includes('pc'));
});

test('turn: auto-load runs a tool from an unloaded group and counts against the cap', async () => {
  const { runner, ctx } = setup();
  const scope = runner.turn(['core']);
  const r = await scope.run('calculate', { expression: '2+3' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.text, /= 5/);
  assert.ok(scope.loaded().includes('math'));
  assert.equal((await scope.run('more_skills', { group: 'timers' }, ctx)).ok, true);
  const third = await scope.run('more_skills', { group: 'knowledge' }, ctx);
  assert.equal(third.ok, false);
  assert.match(third.text, /limit 2/);
});

test('turn: auto-load by alias works too', async () => {
  const { runner, ctx } = setup();
  const scope = runner.turn(['core']);
  const r = await scope.run('start_timer', { duration: '5 minutes' }, ctx);
  assert.doesNotMatch(r.text, /unknown tool/);
  assert.ok(scope.loaded().includes('timers'));
});

test('turn: truly unknown tool still lists what exists', async () => {
  const { runner, ctx } = setup();
  const r = await runner.turn(['core']).run('get_stock_data', {}, ctx);
  assert.equal(r.ok, false);
  assert.match(r.text, /unknown tool get_stock_data\. Tools that exist: .*get_time/);
});

test('turn: auto-load of a confirm tool in a tainted turn is refused', async () => {
  const { runner, deps } = setup();
  const scope = runner.turn(['core']);
  const r = await scope.run('move_files', { from: 'a.txt', to: 'Documents' }, { turn: { tainted: true } });
  assert.equal(r.ok, false);
  assert.match(r.text, /won't start that from text I read/);
  assert.ok(!scope.loaded().includes('pc'));
  assert.deepEqual(deps.pc.host.calls, []);
  // also through its alias
  const r2 = await scope.run('move_file', { from: 'a.txt', to: 'Documents' }, { turn: { tainted: true } });
  assert.match(r2.text, /won't start that from text I read/);
  assert.ok(!scope.loaded().includes('pc'));
});

test('turn: auto-load does not turn a confirm tool into a safe one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'Sorted'));
  const deps = toolDeps();
  deps.pc.roots = [dir];
  const { runner, catalog, ctx } = setup(deps);
  assert.equal(catalog.byName.get('move_files').tool.risk, 'confirm');
  const scope = runner.turn(['core']);
  const r = await scope.run('move_files', { from: path.join(dir, 'a.txt'), to: path.join(dir, 'Sorted') }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith(NEEDS_OK), r.text);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')), 'nothing moved before a yes');
  assert.ok(scope.loaded().includes('pc'));
  // and without a turn at all it is refused
  assert.equal((await runner.turn(['core']).run('move_files', { from: 'a', to: 'b' }, {})).ok, false);
});

test('turn: flat runner (no groups) exposes every tool', () => {
  const { catalog } = setup();
  const flat = createToolRunner(catalog.tools);
  assert.equal(flat.turn([]).specs().length, catalog.tools.length);
  assert.equal(flat.specs().length, catalog.tools.length);
});

test('turn: hints() returns the hints of loaded groups only', () => {
  const groups = [
    { id: 'core', label: 'c', triggers: [], hint: 'H-core', tools: [{ name: 'a', description: '', params: {}, run: async () => 'a' }] },
    { id: 'x', label: 'x', triggers: [], hint: 'H-x', tools: [{ name: 'b', description: '', params: {}, run: async () => 'b' }] },
  ];
  const runner = createToolRunner(groups.flatMap(g => g.tools), { groups });
  assert.deepEqual(runner.turn(['core']).hints(), ['H-core']);
  assert.deepEqual(runner.turn(['core', 'x']).hints(), ['H-core', 'H-x']);
});

// ---- orchestrator ----
function orcSetup(provider, { selectGroups, route } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsk-orc-'));
  const bus = createBus();
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(provider);
  const { runner } = setup();
  const sysSeen = [];
  const orc = createOrchestrator({
    bus, sessions, providers, tools: runner, getConfig: () => ({ ...DEFAULTS, provider: provider.id }),
    selectGroups, route,
    systemPrompt: ctx => { sysSeen.push(ctx); return `SYS ${ctx.tools.join(',')}`; },
  });
  const s = sessions.create(); sessions.save(s);
  return { orc, s, sysSeen };
}
const toolNames = call => (call.tools || []).map(t => t.name);

test('orchestrator: specs are recomputed each round', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'more_skills', args: { group: 'math' } }, { type: 'done' }],
    [{ type: 'token', text: 'ok' }, { type: 'done' }],
  ]);
  const { orc, s, sysSeen } = orcSetup(fp, { selectGroups: () => ['core'] });
  await orc.send(s.id, 'help', { source: 'text' });
  assert.ok(!toolNames(fp.calls[0]).includes('calculate'));
  assert.ok(toolNames(fp.calls[1]).includes('calculate'));
  assert.match(fp.calls[1].messages[0].content, /calculate/, 'the system prompt names the newly loaded tools');
  assert.ok(sysSeen.length >= 2);
});

test('orchestrator: lastGroups carries to the next turn of the same session', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const seen = [];
  const { orc, s } = orcSetup(fp, { selectGroups: (text, o) => { seen.push(o.lastGroups); return ['core', 'pc']; } });
  await orc.send(s.id, 'one', { source: 'text' });
  await orc.send(s.id, 'two', { source: 'text' });
  assert.deepEqual(seen, [[], ['pc']]);
});

test('orchestrator: lastGroups includes groups loaded mid-turn and is per session', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'more_skills', args: { group: 'math' } }, { type: 'done' }],
    [{ type: 'token', text: 'ok' }, { type: 'done' }],
    [{ type: 'token', text: 'ok' }, { type: 'done' }],
  ]);
  const seen = [];
  const { orc, s } = orcSetup(fp, { selectGroups: (text, o) => { seen.push(o.lastGroups); return ['core']; } });
  await orc.send(s.id, 'one', { source: 'text' });
  await orc.send(s.id, 'two', { source: 'text' });
  await orc.send(null, 'three', { source: 'text' });   // a different session
  assert.deepEqual(seen, [[], ['math'], []]);
});

test('orchestrator: fast tier sends no tools', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  let asked = 0;
  const { orc, s } = orcSetup(fp, { selectGroups: () => { asked++; return ['core']; }, route: () => ({ tier: 'fast', think: false, tools: false, reason: 'chat' }) });
  await orc.send(s.id, 'hi', { source: 'text' });
  assert.equal(fp.calls[0].tools, undefined);
  assert.equal(asked, 0);
});

test('orchestrator: a failed turn does not move lastGroups', async () => {
  const fp = createFakeProvider([[{ type: 'throw', message: 'boom' }], [{ type: 'token', text: 'ok' }, { type: 'done' }]]);
  const seen = [];
  const { orc, s } = orcSetup(fp, { selectGroups: (t, o) => { seen.push(o.lastGroups); return ['core', 'pc']; } });
  await orc.send(s.id, 'one', { source: 'text' });
  await orc.send(s.id, 'two', { source: 'text' });
  assert.deepEqual(seen, [[], []]);
});

test('orchestrator: a tainted turn cannot start a confirm tool through auto-load', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'get_weather', args: {} }, { type: 'done' }],
    [{ type: 'tool_call', id: 'c2', name: 'move_files', args: { from: 'a', to: 'b' } }, { type: 'done' }],
    [{ type: 'token', text: 'ok' }, { type: 'done' }],
  ]);
  const { orc, s } = orcSetup(fp, { selectGroups: () => ['core', 'knowledge'] });
  await orc.send(s.id, 'weather then move', { source: 'text' });
  const tools = fp.calls[2].messages.filter(m => m.role === 'tool');
  assert.match(tools.at(-1).content, /won't start that from text I read/);
  assert.ok(!toolNames(fp.calls[2]).includes('move_files'));
});

test('orchestrator: loading a skill does not back an action claim', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'more_skills', args: { group: 'pc' } }, { type: 'done' }],
    [{ type: 'token', text: 'I opened Chrome.' }, { type: 'done' }],
  ]);
  const { orc, s } = orcSetup(fp, { selectGroups: () => ['core'] });
  const res = await orc.send(s.id, 'open chrome', { source: 'text' });
  assert.match(res.reply, /Correction: I didn't actually do that/);
});
