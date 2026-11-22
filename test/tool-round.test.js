// Parallel read batches: only read tools that need no confirmation share a batch, and an untrusted result taints the turn
// BEFORE the next batch starts, so a confirm call after an untrusted read is refused and never runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { partition, runRound, PARALLEL_MAX } = require('../src/core/tools/round');
const { parallelSafe } = require('../src/core/skills/toolcards');
const { createToolRunner } = require('../src/core/tools/registry');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const job = (name, args = {}, preset = null) => ({ call: { id: name + JSON.stringify(args), name, args }, preset });
const safeOf = name => name.startsWith('read');

test('partition groups consecutive safe reads, everything else is alone', () => {
  const sizes = jobs => partition(jobs, safeOf).map(b => b.length);
  assert.equal(PARALLEL_MAX, 4);
  assert.deepEqual(sizes([job('read1'), job('read2'), job('write'), job('read3')]), [2, 1, 1]);
  assert.deepEqual(sizes([1, 2, 3, 4, 5].map(i => job('read' + i))), [4, 1]);
  assert.deepEqual(sizes([job('read1'), job('read2', {}, { ok: false, text: 'x' }), job('read3')]), [1, 1, 1]);
});

test('reads overlap in time, a write runs alone, results keep job order', async () => {
  const log = [];
  const run = async call => { log.push('s:' + call.name); await sleep(50); log.push('e:' + call.name); return { ok: true, text: call.name }; };
  const t0 = Date.now();
  const out = await runRound({ jobs: [job('read1'), job('read2')], run, turn: {}, signal: new AbortController().signal, parallelSafeOf: safeOf });
  assert.ok(Date.now() - t0 < 90);
  assert.deepEqual(out.map(r => r.text), ['read1', 'read2']);
  log.length = 0;
  await runRound({ jobs: [job('read1'), job('write'), job('read2')], run, turn: {}, signal: new AbortController().signal, parallelSafeOf: safeOf });
  assert.deepEqual(log, ['s:read1', 'e:read1', 's:write', 'e:write', 's:read2', 'e:read2']);
});

test('parallel:false runs every job one after the other', async () => {
  const log = [];
  const run = async call => { log.push('s:' + call.name); await sleep(10); log.push('e:' + call.name); return { ok: true, text: '' }; };
  await runRound({ jobs: [job('read1'), job('read2')], run, turn: {}, signal: new AbortController().signal, parallelSafeOf: safeOf, parallel: false });
  assert.deepEqual(log, ['s:read1', 'e:read1', 's:read2', 'e:read2']);
});

test('identical calls in one batch run once and share the result; a rejection becomes an error result', async () => {
  let n = 0;
  const run = async call => { if (call.name === 'read_boom') throw new Error('boom'); n++; return { ok: true, text: 'r' }; };
  const out = await runRound({ jobs: [job('read1', { a: 1 }), job('read1', { a: 1 }), job('read_boom')], run, turn: {}, signal: new AbortController().signal, parallelSafeOf: safeOf });
  assert.equal(n, 1);
  assert.equal(out[0], out[1]);
  assert.equal(out[2].ok, false);
  assert.match(out[2].text, /^Error: boom/);
});

test('an aborted signal stops later batches without running them', async () => {
  const ac = new AbortController();
  const ran = [];
  const run = async call => { ran.push(call.name); if (call.name === 'write') ac.abort(); return { ok: true, text: 'x' }; };
  const out = await runRound({ jobs: [job('write'), job('read1'), job('write2')], run, turn: {}, signal: ac.signal, parallelSafeOf: safeOf });
  assert.deepEqual(ran, ['write']);
  assert.deepEqual(out.map(r => r.text), ['x', 'Error: aborted', 'Error: aborted']);
});

function realRunner() {
  const counts = { confirm: 0 };
  const tools = [
    { name: 'read_page', description: 'p', params: {}, effect: 'read', untrusted: true, async run() { return 'PAGE'; } },
    { name: 'read_page2', description: 'p', params: {}, effect: 'read', untrusted: true, async run() { return 'PAGE2'; } },
    { name: 'read_clean', description: 'c', params: {}, effect: 'read', async run() { return 'CLEAN'; } },
    { name: 'close_app', description: 'x', params: {}, risk: 'confirm', async run() { counts.confirm++; return 'closed'; } },
  ];
  const runner = createToolRunner(tools);
  const parallelSafeOf = n => { const t = tools.find(x => x.name === n); return !!t && parallelSafe(t); };
  return { counts, runner, parallelSafeOf };
}

test('an untrusted read taints the turn before a confirm call in the same round, which is refused and never runs', async () => {
  const { counts, runner, parallelSafeOf } = realRunner();
  const turn = { tainted: false };
  const run = (call, extra = {}) => runner.run(call.name, call.args, { turn, signal: new AbortController().signal, ...extra });
  const out = await runRound({ jobs: [job('read_page'), job('close_app')], run, turn, signal: new AbortController().signal, parallelSafeOf });
  assert.equal(out[0].ok, true);
  assert.equal(turn.tainted, true);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].denied, true);
  assert.equal(counts.confirm, 0);
});

test('two untrusted reads in one batch then a confirm: refused too', async () => {
  const { counts, runner, parallelSafeOf } = realRunner();
  const turn = { tainted: false };
  const run = call => runner.run(call.name, call.args, { turn });
  const out = await runRound({ jobs: [job('read_page'), job('read_page2'), job('close_app')], run, turn, signal: new AbortController().signal, parallelSafeOf });
  assert.equal(turn.tainted, true);
  assert.equal(out[2].denied, true);
  assert.equal(counts.confirm, 0);
});

test('a clean read then a confirm: the confirm is not refused for taint', async () => {
  const { counts, runner, parallelSafeOf } = realRunner();
  const turn = { tainted: false };
  const run = call => runner.run(call.name, call.args, { turn });
  const out = await runRound({ jobs: [job('read_clean'), job('close_app')], run, turn, signal: new AbortController().signal, parallelSafeOf });
  assert.equal(turn.tainted, false);
  assert.notEqual(out[1].denied, true);
  assert.equal(out[1].ok, true);
});

// -- orchestrator wiring ------------------------------------------------------
function orc(script, intelligence) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-round-'));
  const log = [];
  const mk = (name, effect, ms) => ({ name, description: name, params: {}, effect, async run() { log.push('s:' + name); await sleep(ms); log.push('e:' + name); return name + ' done'; } });
  const tools = createToolRunner([mk('read_a', 'read', 40), mk('read_b', 'read', 10), mk('do_w', 'write', 5)]);
  const fp = createFakeProvider(script);
  const bus = createBus();
  const providers = createRegistry(); providers.add(NullProvider); providers.add(fp);
  const sessions = createSessionStore(dir);
  const events = [];
  bus.on('tool', e => events.push(`${e.phase}:${e.name}`));
  const o = createOrchestrator({ bus, sessions, providers, tools, intelligence, getConfig: () => ({ ...DEFAULTS, provider: fp.id }), route: () => ({ tier: 'deep', think: false, tools: true, reason: 'test' }) });
  const s = sessions.create(); sessions.save(s);
  return { o, s, sessions, log, events, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const call = (id, name) => ({ type: 'tool_call', id, name, args: {} });
const twoReads = [[call('1', 'read_a'), call('2', 'read_b'), { type: 'done' }], [{ type: 'token', text: 'ok' }, { type: 'done' }]];

test('orchestrator: two reads overlap, session messages and end events stay in call order', async () => {
  const r = orc(twoReads, {});
  await r.o.send(r.s.id, 'go');
  const tm = r.sessions.load(r.s.id).messages.filter(m => m.role === 'tool');
  assert.deepEqual(tm.map(m => m.toolCallId), ['1', '2']);
  assert.deepEqual(r.log.slice(0, 2), ['s:read_a', 's:read_b']);
  assert.deepEqual(r.events.filter(e => e.startsWith('end')), ['end:read_a', 'end:read_b']);
  r.done();
});

test('orchestrator: a write in the round keeps serial order', async () => {
  const r = orc([[call('1', 'read_a'), call('2', 'do_w'), call('3', 'read_b'), { type: 'done' }], [{ type: 'token', text: 'ok' }, { type: 'done' }]], {});
  await r.o.send(r.s.id, 'go');
  assert.deepEqual(r.log, ['s:read_a', 'e:read_a', 's:do_w', 'e:do_w', 's:read_b', 'e:read_b']);
  r.done();
});

test('orchestrator: intelligence.parallel false is serial as before', async () => {
  const r = orc(twoReads, { parallel: false });
  await r.o.send(r.s.id, 'go');
  assert.deepEqual(r.log, ['s:read_a', 'e:read_a', 's:read_b', 'e:read_b']);
  const tm = r.sessions.load(r.s.id).messages.filter(m => m.role === 'tool');
  assert.deepEqual(tm.map(m => m.toolCallId), ['1', '2']);
  r.done();
});
