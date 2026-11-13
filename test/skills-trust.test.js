// Phase 3: skill calling you can trust. Ask or decline instead of guessing, arguments checked before a tool runs,
// a tool that says "nothing happened" never backs a claim, and the request → skill table.
const test = require('node:test');
const assert = require('node:assert/strict');
const { clarify } = require('../src/core/skills/clarify');
const { checkArgs } = require('../src/core/tools/args');
const { createToolRunner } = require('../src/core/tools/registry');
const { softFail, unbackedClaim } = require('../src/core/brain/guard');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { toolDeps } = require('./helpers/tool-deps');
const rows = require('./fixtures/skill-requests.json');

test('clarify: a bare pronoun with nothing earlier to point at is asked about', () => {
  assert.equal(clarify('turn it off').kind, 'ask');
  assert.equal(clarify('turn it off').reply, 'What should I turn off?');
  assert.equal(clarify('Jarvis, delete that.').reply, 'What should I delete?');
  assert.match(clarify('do that again').reply, /Do what again/);
  assert.equal(clarify('send it to him').kind, 'ask');
});

test('clarify: an earlier action gives "it" a meaning, so it is not asked', () => {
  assert.equal(clarify('close it', { lastGroups: ['core', 'pc'] }), null);
  assert.equal(clarify('close it', { lastGroups: ['core'] }).kind, 'ask', 'core alone is not an earlier action');
});

test('clarify: a noun or a destination means there is something to act on', () => {
  for (const t of ['close this tab', 'open that link', 'move this to my second monitor', 'move it to desktop 2', 'delete the old screenshots', 'turn off night light', 'undo that', 'stop it']) {
    assert.equal(clarify(t), null, t);
  }
});

test('clarify: things JARVIS has no tool for are declined plainly, wherever the chat is', () => {
  for (const [t, what] of [['turn off the living room lights', 'control lights'], ['set the thermostat to 70', 'control the thermostat'], ['order me a pizza', 'place orders'],
    ['text my mom that I am late', 'send messages or make calls'], ['book a flight to Denver', 'book travel or reservations'], ['unlock the front door', 'control door locks'], ['send an email to Bob', 'send email or messages']]) {
    const c = clarify(t, { lastGroups: ['pc'] });
    assert.equal(c?.kind, 'decline', t);
    assert.match(c.reply, new RegExp(what));
  }
});

test('clarify: things JARVIS can do are never intercepted', () => {
  for (const t of ['turn on night light', 'lock my pc', 'call me Daniel', 'write an email to Bob about Friday', 'order of operations in math', 'what is the light speed', 'set a timer for 10 minutes', 'tell me a joke']) {
    assert.equal(clarify(t), null, t);
  }
});

test('args: harmless mismatches are fixed, impossible ones are refused with the allowed values', () => {
  const tool = { name: 't', params: { type: 'object', properties: { n: { type: 'number' }, on: { type: 'boolean' }, mode: { type: 'string', enum: ['a', 'b'] }, q: { type: 'string' } }, required: ['q'] } };
  assert.deepEqual(checkArgs(tool, { q: 'x', n: '5', on: 'TRUE', mode: 'A' }), { ok: true, args: { q: 'x', n: 5, on: true, mode: 'a' } });
  const missing = checkArgs(tool, { n: 1 });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /q is required/);
  assert.match(missing.text, /was not run/);
  assert.match(checkArgs(tool, { q: 'x', mode: 'zzz' }).text, /mode must be one of a, b/);
  assert.match(checkArgs(tool, { q: 'x', n: 'abc' }).text, /n should be number/);
  assert.equal(checkArgs(tool, [1, 2]).ok, false);
  assert.deepEqual(checkArgs({ name: 'free' }, { anything: 1 }), { ok: true, args: { anything: 1 } }, 'no schema, no check');
  assert.equal(checkArgs(tool, { q: 'x', extra: 1 }).args.extra, 1, 'unlisted arguments are kept');
});

test('runner: a call with bad arguments does not run the tool, says so, and counts it', async () => {
  let ran = 0;
  const tool = { name: 'set_thing', description: 'x', params: { type: 'object', properties: { level: { type: 'number' } }, required: ['level'] }, async run(a) { ran++; return `level ${a.level}`; } };
  const runner = createToolRunner([tool]);
  const bad = await runner.run('set_thing', {});
  assert.equal(bad.ok, false);
  assert.match(bad.text, /level is required/);
  assert.equal(ran, 0);
  assert.equal(runner.stats().get('set_thing').badArgs, 1);
  const good = await runner.run('set_thing', { level: '7' });
  assert.deepEqual(good, { ok: true, text: 'level 7' });
  assert.equal(ran, 1);
});

test('guard: a tool that says it did nothing never backs a claim', () => {
  for (const t of ['Could not find a window called zoom', 'No change: already paused', 'Nothing was changed', "Isn't connected", 'Unable to reach the player', 'Not supported by this player']) assert.equal(softFail(t), true, t);
  for (const t of ['Paused.', 'Volume set to 40%', 'Playing Bohemian Rhapsody', 'Window moved to the left']) assert.equal(softFail(t), false, t);
  // with no backing tool, "I paused it" is flagged; the orchestrator now counts a soft failure as no backing
  assert.equal(unbackedClaim('I have paused it.', 0), true);
});

test('select: reports how sure the match is without changing the returned array', () => {
  const catalog = buildCatalog(loadGroups(toolDeps()));
  const none = selectGroups('hmm', {}, catalog);
  assert.deepEqual(none, ['core', 'knowledge']);
  assert.equal(none.confidence, 'low');
  assert.equal(Object.keys(none).join(), '0,1', 'the confidence is not an enumerable property');
  assert.equal(selectGroups('set a timer for ten minutes', {}, catalog).confidence, 'high');
  assert.ok(['medium', 'high'].includes(selectGroups('is it going to rain', {}, catalog).confidence));
});

test('skill table: every row names a real tool in the group it should come from, and selection meets the accuracy bar', () => {
  const catalog = buildCatalog(loadGroups(toolDeps()));
  const groupOf = name => catalog.groups.find(g => g.tools.some(t => t.name === name))?.id;
  let ok = 0;
  const miss = [];
  for (const row of rows) {
    if (row.tool) assert.ok(row.group.includes(groupOf(row.tool)), `${row.text}: ${row.tool} lives in ${groupOf(row.tool)}, not ${row.group}`);
    const picked = selectGroups(row.text, { lastGroups: [] }, catalog);
    const c = clarify(row.text, { lastGroups: [], picked, catalog });
    const pass = row.outcome === 'ask' ? c?.kind === 'ask' : row.outcome === 'decline' ? c?.kind === 'decline' : row.outcome === 'answer' ? !c
      : !c && row.group.some(g => picked.includes(g)) && picked.includes(groupOf(row.tool));
    if (pass) ok++; else miss.push(row.text);
  }
  assert.ok(ok / rows.length >= 0.95, `accuracy ${Math.round(ok / rows.length * 100)}%: missed ${miss.join(' | ')}`);
});

const { ungroundedFigures } = require('../src/core/brain/guard');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { DEFAULTS } = require('../src/core/config');
const { createFakeProvider } = require('./helpers/fake-provider');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('guard: a precise figure with no source in the results or the question is caught; roundings and years are not', () => {
  assert.deepEqual(ungroundedFigures('It is 1,234.5 metres.', ['Result: 1234.5']), []);
  assert.deepEqual(ungroundedFigures('About 21.4 degrees.', ['temp 21.43']), [], 'a rounding of a result');
  assert.deepEqual(ungroundedFigures('Born in 1969, it weighs 4821 grams.', ['mass: 4,821 g']), []);
  assert.deepEqual(ungroundedFigures('The answer is 7342.19.', ['result 7324.19', 'user asked 12 times 4']), ['7342.19']);
  assert.deepEqual(ungroundedFigures('You have 3 of 5 left.', []), [], 'small numbers are not policed');
});

test('orchestrator: after tools, an answer with an untraceable figure is asked again once, then the traced answer is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ground-'));
  const bus = createBus(); const logs = [];
  bus.on('log', e => logs.push(e.text));
  const provider = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'calculate', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'It comes to 99999.77.' }, { type: 'done' }],
    [{ type: 'token', text: 'It comes to 7324.19.' }, { type: 'done' }],
  ]);
  const providers = createRegistry(); providers.add(NullProvider); providers.add(provider);
  const tools = createToolRunner([{ name: 'calculate', description: 'c', params: {}, async run() { return 'Result: 7324.19'; } }]);
  const sessions = createSessionStore(dir);
  const orc = createOrchestrator({ bus, sessions, providers, tools, getConfig: () => ({ ...DEFAULTS, provider: 'fake' }) });
  const s = sessions.create(); sessions.save(s);
  const res = await orc.send(s.id, 'what is 1 plus 1 plus the thing', { source: 'text' });
  assert.equal(res.reply, 'It comes to 7324.19.');
  assert.equal(provider.calls.length, 3);
  assert.match(provider.calls[2].messages.at(-1).content, /99999\.77/);
  assert.ok(logs.some(t => /figures no tool result contains/.test(t)));
});
