// Recovery policy: classify a failure, decide retry/repair/verify, and never repeat a write that may have happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classify, plan, backoffMs, NO_RETRY } = require('../src/core/tools/recover');
const { attemptCall } = require('../src/core/tools/round');
const { createToolRunner } = require('../src/core/tools/registry');
const { toolContract } = require('../src/core/skills/toolcards');
const { createLedger } = require('../src/core/tools/ledger');
const { createTaskStore } = require('../src/core/tasks/store');
const { createTaskRunner } = require('../src/core/tasks/runner');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('classify: failure classes', () => {
  assert.equal(classify({ ok: true, text: 'x' }), 'ok');
  assert.equal(classify({ ok: false, badArgs: true, text: 'Error: bad' }), 'bad_args');
  assert.equal(classify({ ok: false, timedOut: true, text: 'Error: tool x timed out' }), 'timeout');
  assert.equal(classify({ ok: false, text: 'Error: ECONNRESET' }), 'transient');
  assert.equal(classify({ ok: false, text: 'Error: Chrome extension not connected' }), 'unavailable');
  assert.equal(classify({ ok: false, text: 'Error: unknown tool foo. Did you mean bar? try again' }), 'unknown_tool');
  assert.equal(classify({ ok: false, text: 'Error: file not found' }), 'fatal');
  assert.equal(classify({ ok: false, denied: true, text: 'Error: no' }), 'denied');
  assert.equal(classify({ ok: false, text: 'Error: aborted' }), 'aborted');
  assert.ok(NO_RETRY.test('timed out'));
});

test('plan: retries only for reads or idempotent tools on attempt 0', () => {
  const read = { effect: 'read', idempotent: true, attempt: 0 };
  const write = { effect: 'write', idempotent: false, attempt: 0 };
  assert.equal(plan('ok', write), 'accept');
  assert.equal(plan('transient', read), 'retry');
  assert.equal(plan('transient', write), 'stop');
  assert.equal(plan('transient', { ...write, idempotent: true }), 'retry');
  assert.equal(plan('transient', { ...read, attempt: 1 }), 'stop');
  assert.equal(plan('timeout', write), 'verify_or_unknown');
  assert.equal(plan('timeout', { effect: 'external', idempotent: false, attempt: 0 }), 'verify_or_unknown');
  assert.equal(plan('timeout', read), 'retry');
  assert.equal(plan('bad_args', write), 'repair');
  assert.equal(plan('bad_args', { ...write, attempt: 1 }), 'stop');
  assert.equal(plan('unavailable', write), 'rediscover');
  assert.equal(plan('unknown_tool', write), 'rediscover');
  for (const c of ['denied', 'aborted', 'fatal']) assert.equal(plan(c, read), 'stop');
  assert.deepEqual([0, 1, 2, 3, 4].map(backoffMs), [250, 500, 1000, 1000, 1000]);
});

// -- attemptCall with a fake run ----------------------------------------------
const mkRun = (script, counts = {}) => async (c, extra = {}) => { counts[c.name] = (counts[c.name] || 0) + 1; return script(c, extra, counts[c.name]); };
const READ = { effect: 'read', idempotent: true, verify: null };
const WRITE = { effect: 'write', idempotent: false, verify: null };

test('attemptCall: a read failing once with ECONNRESET is retried after 250 ms', async () => {
  const counts = {}, waits = [];
  const run = mkRun((c, e, n) => (n === 1 ? { ok: false, text: 'Error: ECONNRESET' } : { ok: true, text: 'fine' }), counts);
  const res = await attemptCall({ call: { name: 'r', args: {} }, run, contractOf: () => READ, sleep: ms => { waits.push(ms); } });
  assert.equal(res.ok, true);
  assert.equal(res.retried, true);
  assert.equal(counts.r, 2);
  assert.deepEqual(waits, [250]);
});

test('attemptCall: a non-idempotent write failing with ECONNRESET runs once', async () => {
  const counts = {};
  const run = mkRun(() => ({ ok: false, text: 'Error: ECONNRESET' }), counts);
  const res = await attemptCall({ call: { name: 'w', args: {} }, run, contractOf: () => WRITE, sleep: async () => {} });
  assert.equal(res.ok, false);
  assert.equal(counts.w, 1);
});

test('attemptCall: bad args are repaired once and the repaired call runs', async () => {
  const seen = [];
  const run = async c => { seen.push(c.args); return c.args.ok ? { ok: true, text: 'done' } : { ok: false, badArgs: true, text: 'Error: bad' }; };
  const res = await attemptCall({ call: { name: 'w', args: { q: 1 } }, run, contractOf: () => WRITE, repair: async () => ({ name: 'w', args: { ok: true } }) });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [{ q: 1 }, { ok: true }]);
  const seen2 = [];
  const bad = await attemptCall({ call: { name: 'w', args: { q: 1 } }, run: async () => { seen2.push(1); return { ok: false, badArgs: true, text: 'Error: bad' }; }, contractOf: () => WRITE, repair: async () => null });
  assert.equal(bad.ok, false);
  assert.equal(seen2.length, 1);
});

test('attemptCall: unavailable and unknown tool are marked for rediscovery', async () => {
  const res = await attemptCall({ call: { name: 'browse', args: {} }, run: async () => ({ ok: false, text: 'Error: Chrome extension not connected' }), contractOf: () => READ });
  assert.equal(res.rediscover, true);
  assert.equal(res.tool, 'browse');
});

// -- real runner: timeout and verify ------------------------------------------
function verifyRunner() {
  const counts = { w: 0 };
  const list = { text: 'tea timer' };
  const verify = { tool: 'list_timers', args: () => ({}), expect: { contains: 'tea' } };
  const tools = [
    { name: 'w', description: 'w', params: {}, effect: 'write', timeoutMs: 20, verify, async run() { counts.w++; await sleep(100); return 'set'; } },
    { name: 'ok_w', description: 'w', params: {}, effect: 'write', verify, async run() { counts.w++; return 'Set a tea timer'; } },
    { name: 'nov', description: 'w', params: {}, effect: 'write', timeoutMs: 20, async run() { counts.w++; await sleep(100); return 'x'; } },
    { name: 'list_timers', description: 'l', params: {}, effect: 'read', async run() { return list.text; } },
    { name: 'calculate', description: 'c', params: {}, effect: 'write', verify, async run() { return '4'; } },
  ];
  const runner = createToolRunner(tools);
  const ledger = createLedger();
  const call = (name, turn = {}) => attemptCall({
    call: { id: name, name, args: {} },
    run: (c, x = {}) => runner.run(c.name, c.args, { turn, sessionId: 's', ledger, turnId: 't', signal: new AbortController().signal, ...x }),
    contractOf: n => { const t = runner.get(n); return t ? toolContract(t) : null; },
    sleep: async () => {},
  });
  return { counts, list, call };
}

test('timed-out write with a verify read that confirms: ok, verified, ran once', async () => {
  const v = verifyRunner();
  const res = await v.call('w');
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
  assert.match(res.text, /timed out, but I checked and it went through: tea timer/);
  assert.equal(v.counts.w, 1);
});

test('timed-out write whose verify read finds nothing: unknown, not retried, ledger refuses a repeat', async () => {
  const v = verifyRunner();
  v.list.text = '';
  const res = await v.call('w');
  assert.equal(res.ok, false);
  assert.equal(res.unknown, true);
  assert.match(res.text, /could not confirm/);
  assert.equal(v.counts.w, 1);
  const again = await v.call('w');
  assert.equal(again.ledger, 'unknown');
  assert.equal(v.counts.w, 1);
});

test('timed-out write with no verify: outcome unknown, never retried', async () => {
  const v = verifyRunner();
  const res = await v.call('nov');
  assert.equal(res.ok, false);
  assert.equal(res.unknown, true);
  assert.match(res.text, /outcome is unknown/);
  assert.equal(v.counts.w, 1);
});

test('successful write: verify read confirms, or flags it without retrying', async () => {
  const v = verifyRunner();
  const good = await v.call('ok_w');
  assert.equal(good.verified, true);
  const v2 = verifyRunner();
  v2.list.text = 'No timers.';
  const bad = await v2.call('ok_w');
  assert.equal(bad.ok, true);
  assert.equal(bad.verified, false);
  assert.match(bad.text, /could not confirm/);
  assert.equal(v2.counts.w, 1);
});

test('the verify read is authorized by exec: a guest turn refuses a tool outside GUEST_TOOLS', async () => {
  const v = verifyRunner();
  const res = await v.call('calculate', { speaker: 'guest' });
  assert.notEqual(res.verified, true);
  assert.match(res.text, /could not confirm/);
});

test('verify expect function returning null means nothing checkable: result passes through', async () => {
  const run = async c => (c.name === 'x' ? { ok: true, text: 'did' } : { ok: true, text: 'whatever' });
  const contract = { effect: 'write', idempotent: false, verify: { tool: 'v', args: () => ({}), expect: () => null } };
  const res = await attemptCall({ call: { name: 'x', args: {} }, run, contractOf: () => contract });
  assert.deepEqual(res, { ok: true, text: 'did' });
});

// -- task runner ---------------------------------------------------------------
test('task runner: canRetry false means a failing step is not retried; without it the retry stays', async () => {
  for (const [opts, expected] of [[{ canRetry: () => false }, 1], [{}, 2]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-rec-'));
    let n = 0;
    const tools = { resolves: () => true, async run() { n++; return { ok: false, text: 'flaky glitch' }; } };
    const runner = createTaskRunner({ store: createTaskStore({ dir }), tools, bus: { emit() {} }, ...opts });
    await runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
    assert.equal(n, expected);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -- orchestrator: abort ------------------------------------------------------
test('orchestrator: a stop mid-round still ends every started call and keeps a tool message for each', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-rec-'));
  const sessions = createSessionStore(dir);
  const bus = createBus();
  let o;
  const tools = createToolRunner([
    { name: 'read_a', description: 'a', params: {}, effect: 'read', async run() { o.stop(); return 'a done'; } },
    { name: 'read_b', description: 'b', params: {}, effect: 'read', async run() { return 'b done'; } },
  ]);
  const fp = createFakeProvider([[{ type: 'tool_call', id: '1', name: 'read_a', args: {} }, { type: 'tool_call', id: '2', name: 'read_b', args: {} }, { type: 'done' }]]);
  const providers = createRegistry(); providers.add(NullProvider); providers.add(fp);
  const events = [];
  bus.on('tool', e => events.push(`${e.phase}:${e.name}`));
  o = createOrchestrator({ bus, sessions, providers, tools, intelligence: { parallel: false }, getConfig: () => ({ ...DEFAULTS, provider: fp.id }), route: () => ({ tier: 'deep', think: false, tools: true, reason: 'test' }) });
  const s = sessions.create(); sessions.save(s);
  await o.send(s.id, 'go');
  assert.deepEqual(events.filter(e => e.startsWith('end')).sort(), ['end:read_a', 'end:read_b']);
  assert.deepEqual(sessions.load(s.id).messages.filter(m => m.role === 'tool').map(m => m.toolCallId), ['1', '2']);
  fs.rmSync(dir, { recursive: true, force: true });
});
