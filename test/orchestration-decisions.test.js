// What JARVIS decides a request needs: depth, instant answers, asking first, context, model choice, failure handling.
// The same cases (and the live score) are in scripts/orchestration-bench.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cases = require('./fixtures/orchestration-cases.json');
const { route } = require('../src/core/brain/router');
const { instant } = require('../src/core/brain/instant');
const { clarify } = require('../src/core/skills/clarify');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { createOllamaProvider } = require('../src/core/providers/ollama');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');
const { toolDeps } = require('./helpers/tool-deps');

const catalog = buildCatalog(loadGroups(toolDeps()));
const NOW = new Date(2026, 10, 12, 15, 42);

test('route: every case in the table gets its tier, tools and thinking', () => {
  const bad = [];
  for (const c of cases.route) {
    const r = route(c.text, { source: c.source || 'text' });
    const got = `${r.tier}/${r.tools !== false}/${!!r.think}`;
    if (got !== `${c.tier}/${c.tools}/${c.think}`) bad.push(`"${c.text}": wanted ${c.tier}/${c.tools}/${c.think}, got ${got}`);
  }
  assert.deepEqual(bad, []);
});

test('route: depth is 0 for chat, 1 for a task, 2 only when thinking', () => {
  assert.equal(route('hi').depth, 0);
  assert.equal(route('turn the volume down').depth, 1);
  assert.equal(route('Prove that there are infinitely many primes.').depth, 2);
  assert.equal(route('Prove that there are infinitely many primes.', { source: 'voice' }).depth, 1);
});

test('route: steps counts what a request asks for, so a long task gets more tool rounds', () => {
  assert.equal(route('pause the music').steps, 1);
  assert.ok(route('pause the music, then set a timer for 5 minutes and open chrome').steps >= 3);
});

test('route: a reminder or a timer is a task, never quick chat without tools', () => {
  for (const t of ['remind me to call mom at 5', 'set a timer for 3 minutes', 'cancel my alarm']) assert.equal(route(t).tools, true, t);
});

test('route: a request with a task in it stays a task even when it starts like chat', () => {
  for (const t of ['Hey Jarvis, can you play some jazz', 'hi, set a timer for 5 minutes', "I'm bored, open chrome", 'hey jarvis what is the weather today']) {
    assert.notEqual(route(t).tools, false, t);
  }
});

test('instant: time, date and plain arithmetic are answered without the model', () => {
  const bad = [];
  for (const c of cases.instant) if (!!instant(c.text, { now: NOW, locale: 'en-US' }) !== c.instant) bad.push(c.text);
  assert.deepEqual(bad, []);
  assert.equal(instant('what time is it', { now: NOW, locale: 'en-US' }).reply, "It's 3:42 PM.");
  assert.equal(instant("what's today's date", { now: NOW, locale: 'en-US' }).reply, "It's Thursday, November 12, 2026.");
  assert.equal(instant('what is 17 * 23', { now: NOW }).reply, '17 * 23 = 391.');
  assert.equal(instant("what's 18% of 240", { now: NOW }).reply, '18% of 240 = 43.2.');
  assert.equal(instant('what is the square root of 144', { now: NOW }).reply, 'square root of 144 = 12.');
});

test('instant: never guesses: dates, divide by zero and extra words go to the model', () => {
  for (const t of ['what is 2024-11-12', 'what is 1/0', 'what is 5 plus the speed of light', 'what is 2^100000', '', 'what is 5']) {
    assert.equal(instant(t, { now: NOW }), null, t);
  }
});

test('clarify: a request missing what the tool needs is asked about, one that has it is not', () => {
  const bad = [];
  for (const c of cases.ask) {
    const r = clarify(c.text, { lastGroups: [] });
    if (c.outcome === 'ask' ? r?.kind !== 'ask' : r) bad.push(c.text);
  }
  assert.deepEqual(bad, []);
  assert.equal(clarify('set a timer', {}).reply, 'For how long should I set the timer?');
  assert.equal(clarify('set a timer', { lastGroups: ['pc'] })?.kind, 'ask', 'missing detail does not depend on the chat before');
});

test('select: a short continuation keeps the one skill area of the turn before; ambiguous or unrelated ones do not', () => {
  const sel = (text, lastGroups) => selectGroups(text, { lastGroups, source: 'text' }, catalog);
  assert.deepEqual(sel('actually make it 10', ['timers']), ['core', 'timers']);
  assert.equal(sel('actually make it 10', ['timers']).confidence, 'medium');
  assert.deepEqual(sel('something more upbeat', ['timers', 'media']), ['core', 'timers', 'media'], 'two areas and nothing that separates them: both');
  assert.deepEqual(sel('a bit louder', ['timers', 'media']), ['core', 'media'], 'two areas: the one whose tools the words fit');
  assert.deepEqual(sel('actually cancel the timer', ['timers', 'media']), ['core', 'timers']);
  assert.deepEqual(sel('tell me a joke', ['timers']), ['core', 'knowledge']);
  assert.deepEqual(sel('actually make it 10', []), ['core', 'knowledge']);
  assert.deepEqual(sel('actually make it ten and then maybe we could look at the rest of the arrangement later on', ['timers']), ['core', 'knowledge'], 'long: not a continuation');
});

// model choice
function ollama(installed, cfg, loaded) {
  const tags = { models: installed.map(m => ({ name: m.name, details: { parameter_size: m.size }, capabilities: m.caps, ...(m.remote ? { remote_model: 'x' } : {}) })) };
  const fetch = async url => {
    if (String(url).endsWith('/api/ps')) { if (!loaded) throw new Error('no ps'); return { ok: true, status: 200, json: async () => ({ models: loaded.map(name => ({ name })) }) }; }
    return { ok: true, status: 200, json: async () => (String(url).endsWith('/api/tags') ? tags : {}) };
  };
  return createOllamaProvider({ getConfig: () => ({ ollama: { host: 'http://127.0.0.1:11434', auto: true, think: false, ...cfg } }), fetch });
}

test('models: every case in the table picks an installed model that can do the turn', async () => {
  const bad = [];
  for (const c of cases.models.cases) {
    const p = ollama(cases.models.installed, c.cfg, c.loaded);
    await p.status();
    const got = p.resolveModel(c.hints);
    if (c.want ? !c.want.includes(got) : c.wantNot.includes(got)) bad.push(`${c.id}: ${got}`);
  }
  assert.deepEqual(bad, []);
});

test('models: with auto routing off, the configured model is kept as long as it is installed', async () => {
  const p = ollama(cases.models.installed, { model: 'dolphin3:8b', auto: false });
  await p.status();
  assert.equal(p.resolveModel({ tier: 'deep', think: true, tools: true }), 'dolphin3:8b');
});

test('models: a model that just failed is avoided on the retry when another one can serve', async () => {
  const p = ollama(cases.models.installed, { model: 'jarvis-worker:latest' });
  await p.status();
  const alt = p.resolveModel({ tier: 'deep', tools: true, avoid: 'jarvis-worker:latest' });
  assert.notEqual(alt, 'jarvis-worker:latest');
  assert.ok(['jarvis-worker8:latest', 'qwen3:8b', 'qwen2.5:7b-instruct', 'qwen2.5:3b', 'jarvis-router:latest'].includes(alt), alt);
});

test('models: nothing known about the installed models yet → the configured model', () => {
  const p = ollama(cases.models.installed, { model: 'jarvis-worker:latest' });
  assert.equal(p.resolveModel({ tier: 'deep', think: true, tools: true }), 'jarvis-worker:latest');
});

// runtime
function run(script, toolDefs, { text = 'do the thing please', orc: extra = {}, provider } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-od-'));
  const fp = provider || createFakeProvider(script);
  const bus = createBus();
  const events = [];
  bus.on('*', ev => events.push(ev));
  const providers = createRegistry(); providers.add(NullProvider); providers.add(fp);
  const sessions = createSessionStore(dir);
  const orc = createOrchestrator({ bus, sessions, providers, tools: createToolRunner(toolDefs), getConfig: () => ({ ...DEFAULTS, provider: fp.id }), ...extra });
  return { orc, fp, events, sessions, text, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const call = (name, args) => ({ type: 'tool_call', id: 'c', name, args });
const say = text => [{ type: 'token', text }, { type: 'done' }];

test('runtime: a tool that failed twice this turn is not run again and is no longer offered', async () => {
  let ran = 0;
  const flaky = { name: 'flaky', description: 'x', params: { type: 'object', properties: { n: { type: 'number' } } }, async run() { ran++; throw new Error('backend is down'); } };
  const t = run([...[0, 1, 2, 3].map(n => [call('flaky', { n }), { type: 'done' }]), say('It failed.')], [flaky]);
  const res = await t.orc.send(null, t.text);
  assert.equal(ran, 2);
  assert.equal(res.reply, 'It failed.');
  assert.ok(t.fp.calls.slice(2).every(c => !c.tools?.some(x => x.name === 'flaky')), 'withdrawn after the second failure');
  assert.match(t.sessions.load(res.sessionId).messages.filter(m => m.role === 'tool').at(-1).content, /already failed 2 times/);
  t.done();
});

test('runtime: a failure is counted per action, and bad arguments are not a failure', async () => {
  let ran = 0;
  const multi = { name: 'multi', description: 'x', params: { type: 'object', properties: { action: { type: 'string' } } }, async run(a) { ran++; if (a.action === 'bad') throw new Error('nope'); return 'fine'; } };
  const t = run([[call('multi', { action: 'bad', n: 1 })], [call('multi', { action: 'bad', n: 2 })], [call('multi', { action: 'bad', n: 3 })], [call('multi', { action: 'good' })], say('Done.')], [multi]);
  const res = await t.orc.send(null, t.text);
  assert.equal(res.reply, 'Done.');
  assert.equal(ran, 3, 'bad twice, then good; the third bad was refused');
  t.done();
});

test('runtime: a model call that fails once is retried once, with the failed model avoided', async () => {
  const fp = createFakeProvider([[{ type: 'throw', message: 'Ollama HTTP 500' }], say('Back.')]);
  const avoided = [];
  fp.resolveModel = h => { avoided.push(h.avoid || null); return h.avoid ? 'other' : 'main'; };
  const t = run(null, [], { provider: fp });
  const res = await t.orc.send(null, t.text);
  assert.equal(res.reply, 'Back.');
  assert.equal(res.error, undefined);
  assert.equal(fp.calls.length, 2);
  assert.ok(avoided.includes('main') || avoided.includes(null));
  assert.equal(fp.calls[1].hints?.avoid, 'main');
  t.done();
});

test('runtime: failures a retry cannot fix, and a second failure, still end in an error', async () => {
  let t = run([[{ type: 'throw', message: 'Ollama is not running' }], say('x')], []);
  let res = await t.orc.send(null, t.text);
  assert.equal(res.error, 'Ollama is not running');
  assert.equal(t.fp.calls.length, 1);
  t.done();
  t = run([[{ type: 'throw', message: 'Ollama HTTP 500' }], [{ type: 'throw', message: 'Ollama HTTP 500' }], say('x')], []);
  res = await t.orc.send(null, t.text);
  assert.equal(res.error, 'Ollama HTTP 500');
  assert.equal(t.fp.calls.length, 2);
  t.done();
});

test('runtime: at the tool-round limit the model gets one last round with no tools and answers', async () => {
  const echo = { name: 'echo', description: 'x', params: { type: 'object', properties: { n: { type: 'number' } } }, async run(a) { return 'ok ' + a.n; } };
  const t = run([...[0, 1, 2, 3, 4, 5].map(n => [call('echo', { n }), { type: 'done' }]), say('Here is what I have.')], [echo], { orc: { maxToolRounds: 5 } });
  const res = await t.orc.send(null, t.text);
  assert.equal(res.reply, 'Here is what I have.');
  assert.equal(res.error, undefined);
  assert.equal(t.fp.calls.at(-1).tools, undefined);
  assert.match(t.fp.calls.at(-1).messages.at(-1).content, /tool rounds/);
  t.done();
});

test('runtime: a request that asks for several things gets two more tool rounds', async () => {
  const echo = { name: 'echo', description: 'x', params: { type: 'object', properties: { n: { type: 'number' } } }, async run(a) { return 'ok ' + a.n; } };
  const t = run([...[0, 1, 2, 3, 4, 5].map(n => [call('echo', { n }), { type: 'done' }]), say('All done.')], [echo], { orc: { maxToolRounds: 5, route: () => ({ tier: 'deep', tools: true, think: false, steps: 3 }) } });
  const res = await t.orc.send(null, t.text);
  assert.equal(res.reply, 'All done.');
  assert.equal(t.fp.calls.length, 7, 'six tool rounds, then the answer, with no forced last round');
  t.done();
});

test('runtime: JARVIS asked a question → the next short answer is read together with it, a dropped one is not', async () => {
  const seen = [];
  const mk = () => run([say('ok'), say('ok')], [], { orc: { selectGroups: text => { seen.push(text); return ['core']; }, fastPath: text => (/^set a timer$/i.test(text) ? { reply: 'For how long?', ok: true, ask: true } : null) } });
  let t = mk();
  const first = await t.orc.send(null, 'set a timer');
  assert.equal(first.reply, 'For how long?');
  await t.orc.send(first.sessionId, '10 minutes');
  assert.equal(seen.at(-1), 'set a timer 10 minutes');
  await t.orc.send(first.sessionId, '10 minutes');
  assert.equal(seen.at(-1), '10 minutes', 'the question is used once');
  t.done();
  seen.length = 0;
  t = mk();
  const a = await t.orc.send(null, 'set a timer');
  await t.orc.send(a.sessionId, 'never mind');
  assert.equal(seen.at(-1), 'never mind');
  t.done();
});

test('runtime: an instant answer costs no model call', async () => {
  const t = run([say('should not be asked')], [], { orc: { fastPath: text => instant(text, { now: NOW, locale: 'en-US' }) } });
  const res = await t.orc.send(null, 'what time is it');
  assert.equal(res.reply, "It's 3:42 PM.");
  assert.equal(t.fp.calls.length, 0);
  t.done();
});

// tool ranking, direct answers, escalation
const { createRanker } = require('../src/core/skills/rank');

test('rank: the tool a request is about is in the top 3 for most requests; examples and learning move it up', () => {
  const rk = createRanker(catalog.tools);
  const rows = require('./fixtures/skill-requests.json').filter(r => r.tool);
  let hit = 0;
  for (const r of rows) if (rk.rank(r.text).slice(0, 3).some(x => x.name === r.tool)) hit++;
  assert.ok(hit / rows.length >= 0.6, `top-3 ${hit}/${rows.length}`);
  const only = new Set(catalog.tools.map(t => t.name));
  assert.equal(rk.rank('is it raining outside', { only })[0].name, 'get_weather');
  // learning: an odd phrasing the tool text never had
  const before = rk.rank('zorblax the thing').length;
  rk.learn('zorblax the thing', 'set_timer');
  assert.equal(rk.best('zorblax').name, 'set_timer');
  assert.ok(before === 0);
});

test('rank: learning is capped per tool and the oldest request is forgotten', () => {
  const rk = createRanker([{ name: 'a', description: 'alpha' }, { name: 'b', description: 'beta' }], { maxLearned: 2 });
  rk.learn('quux one', 'a'); rk.learn('quux two', 'a'); rk.learn('quux three', 'a');
  assert.equal(rk.history()[0].requests.length, 2);
  assert.equal(rk.best('one'), null, 'forgotten');
  assert.equal(rk.best('three').name, 'a');
});

test('rank: order() puts the best match first and keeps the rest in place', () => {
  const rk = createRanker([{ name: 'x', description: 'apples' }, { name: 'y', description: 'oranges' }, { name: 'z', description: 'pears' }]);
  assert.deepEqual(rk.order('oranges please', [{ name: 'x' }, { name: 'y' }, { name: 'z' }]).map(t => t.name), ['y', 'x', 'z']);
  assert.deepEqual(rk.order('nothing relevant here', [{ name: 'x' }, { name: 'z' }]).map(t => t.name), ['x', 'z']);
});

test('runtime: the model sees the likeliest tool first and tools that worked teach the ranker', async () => {
  const tools = ['alpha', 'beta', 'gamma'].map(n => ({ name: n, description: n, params: { type: 'object', properties: {} }, async run() { return n + ' done'; } }));
  const learned = [];
  const t = run([[call('gamma', {}), { type: 'done' }], say('ok')], tools, { orc: { rankTools: (text, specs) => [...specs].reverse(), learnTool: (text, name) => learned.push([text, name]) } });
  await t.orc.send(null, t.text);
  assert.deepEqual(t.fp.calls[0].tools.map(x => x.name), ['gamma', 'beta', 'alpha']);
  assert.deepEqual(learned, [['do the thing please', 'gamma']]);
  t.done();
});

test('runtime: a simple tool result is the reply; a failure, a long result or a mixed round still goes through the model', async () => {
  const timer = { name: 'set_timer', description: 'x', params: { type: 'object', properties: {} }, direct: true, async run() { return 'Timer set for 5 minutes.'; } };
  const conv = { name: 'convert_units', description: 'x', params: { type: 'object', properties: {} }, direct: t => t + '.', async run() { return '65 mph = 29.06 m/s'; } };
  const plain = { name: 'plain', description: 'x', params: { type: 'object', properties: {} }, async run() { return 'raw data'; } };
  const bad = { name: 'bad_timer', description: 'x', params: { type: 'object', properties: {} }, direct: true, async run() { throw new Error('no'); } };
  const long = { name: 'long', description: 'x', params: { type: 'object', properties: {} }, direct: true, async run() { return 'x'.repeat(400); } };
  const all = [timer, conv, plain, bad, long];
  let t = run([[call('set_timer', {}), { type: 'done' }], say('SHOULD NOT RUN')], all);
  let res = await t.orc.send(null, t.text);
  assert.equal(res.reply, 'Timer set for 5 minutes.');
  assert.equal(t.fp.calls.length, 1, 'one model call');
  t.done();
  t = run([[call('set_timer', {}), call('convert_units', {}), { type: 'done' }], say('x')], all);
  res = await t.orc.send(null, t.text);
  assert.equal(res.reply, 'Timer set for 5 minutes. 65 mph = 29.06 m/s.');
  t.done();
  for (const names of [['plain'], ['bad_timer'], ['long'], ['set_timer', 'plain']]) {
    t = run([[...names.map(n => call(n, {})), { type: 'done' }], say('Model phrased it.')], all);
    res = await t.orc.send(null, t.text);
    assert.equal(res.reply, 'Model phrased it.', names.join('+'));
    assert.equal(t.fp.calls.length, 2, names.join('+'));
    t.done();
  }
});

test('runtime: quick chat that claims an action is redone as a tool turn once (a router miss recovers)', async () => {
  const tool = { name: 'set_timer', description: 'x', params: { type: 'object', properties: {} }, async run() { return 'Timer set.'; } };
  const t = run([say("I've set a timer for 5 minutes."), [call('set_timer', {}), { type: 'done' }], say('Done, it is set.')], [tool], { orc: { route: () => ({ tier: 'fast', tools: false, think: false }), selectGroups: () => ['core'] } });
  const res = await t.orc.send(null, 'timer 5 minutes please');
  assert.equal(res.reply, 'Done, it is set.');
  assert.equal(t.fp.calls[0].tools, undefined);
  assert.ok(t.fp.calls[1].tools?.some(x => x.name === 'set_timer'));
  assert.ok(t.events.some(e => e.type === 'route' && e.reason === 'escalated'));
  t.done();
});

test('ollama: the thinking swap only picks a model that is already loaded; a thinking turn on a model that cannot think asks for reasoning in the prompt', async () => {
  const p = ollama(cases.models.installed, { model: 'qwen2.5:7b-instruct' }, ['qwen2.5:7b-instruct']);
  await p.status();
  assert.equal(p.resolveModel({ tier: 'deep', think: true, tools: true }), 'qwen2.5:7b-instruct');
  const q = ollama(cases.models.installed, { model: 'qwen2.5:7b-instruct' }, ['qwen2.5:7b-instruct', 'qwen3:8b']);
  await q.status();
  assert.equal(q.resolveModel({ tier: 'deep', think: true, tools: true }), 'qwen3:8b');
});

test('tools: only plain-sentence tools are direct', () => {
  const direct = catalog.tools.filter(t => t.direct).map(t => t.name).sort();
  assert.deepEqual(direct, ['calculate', 'cancel_timer', 'convert_units', 'list_timers', 'monitor_set', 'set_alarm', 'set_reminder', 'set_timer']);
});

const { liveIntent, liveReply } = require('../src/core/brain/instant-live');
test('live instant: timers and PC stats questions map to their tool; anything with more in it does not', () => {
  const bad = cases.live.filter(c => (liveIntent(c.text)?.tool || null) !== c.tool).map(c => c.text);
  assert.deepEqual(bad, []);
});

test('live instant: a named part answers with its own part only; errors and long text go to the model', () => {
  const sample = 'CPU 12% (45°C); GPU 3% (40°C); RAM 41%; network down 1.0 MB/s up 20 KB/s; drives C: 60% used.';
  assert.equal(liveReply({ tool: 'get_system_stats', focus: 'GPU' }, sample), 'GPU 3% (40°C).');
  assert.equal(liveReply({ tool: 'get_system_stats', focus: 'disk|drives' }, sample), 'drives C: 60% used.');
  assert.equal(liveReply({ tool: 'get_system_stats' }, sample), sample);
  assert.equal(liveReply({ tool: 'get_system_stats', focus: 'GPU' }, 'CPU 5%.'), null);
  assert.equal(liveReply({ tool: 'get_system_stats' }, 'Error: Sysmon is not running'), null);
  assert.equal(liveReply({ tool: 'list_timers' }, 'x'.repeat(401)), null);
  assert.equal(liveReply({ tool: 'list_timers' }, 'No timers set.'), 'No timers set.');
});
