const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger } = require('../src/core/tools/ledger');
const { createToolRunner } = require('../src/core/tools/registry');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

function rig(toolOver = {}, ledgerOpts = {}) {
  const clock = { t: 1000000 };
  const ledger = createLedger({ now: () => clock.t, ...ledgerOpts });
  const counter = { n: 0 };
  const tool = { name: 'send', description: 's', params: {}, effect: 'write', async run() { counter.n++; return 'sent'; }, ...toolOver };
  const runner = createToolRunner([tool]);
  const ctx = (over = {}) => ({ turn: { tainted: false }, ledger, sessionId: 's1', turnId: 't1', ...over });
  return { clock, ledger, counter, runner, ctx, call: (args = { to: 'a' }, over) => runner.run(tool.name, args, ctx(over)) };
}

test('key is stable, trimmed, lower-cased and never carries force', () => {
  const l = createLedger({});
  assert.equal(l.key('x', { b: ' Hi ', a: 1, c: undefined }, 'read'), l.key('x', { a: 1, b: 'hi' }, 'read'));
  assert.equal(l.key('x', { a: 1, force: true }), l.key('x', { a: 1 }));
  assert.notEqual(l.key('x', { o: { force: true } }), l.key('x', { o: {} }));
});

test('a duplicate write is not run again', async () => {
  const r = rig();
  const a = await r.call();
  const b = await r.call();
  assert.equal(r.counter.n, 1);
  assert.equal(a.text, 'sent');
  assert.match(b.text, /^Already done/);
  assert.equal(b.ledger, 'done');
  assert.equal(b.skipped, true);
});

test('past the TTL the same call runs again', async () => {
  const r = rig();
  await r.call();
  r.clock.t += 61000;
  await r.call();
  assert.equal(r.counter.n, 2);
});

test('force from the runner runs once per turn; the model args.force changes nothing', async () => {
  const r = rig();
  await r.call();
  const m = await r.call({ to: 'a', force: true });
  assert.match(m.text, /^Already done/);
  assert.equal(r.counter.n, 1);
  await r.call({ to: 'a' }, { force: true, turnId: 't2' });
  assert.equal(r.counter.n, 2);
  const again = await r.call({ to: 'a' }, { force: true, turnId: 't2' });
  assert.equal(r.counter.n, 2);
  assert.match(again.text, /^Already done/);
});

test('a non-idempotent write that timed out is unknown, not repeated; idempotent runs again', async () => {
  const slow = () => new Promise(res => setTimeout(() => res('late'), 60));
  const r = rig({ timeoutMs: 10, async run() { r.counter.n++; return slow(); } });
  const first = await r.call();
  assert.equal(first.timedOut, true);
  const second = await r.call();
  assert.equal(second.ledger, 'unknown');
  assert.equal(second.ok, false);
  assert.equal(r.counter.n, 1);
  const q = rig({ idempotent: true, timeoutMs: 10, async run() { q.counter.n++; return slow(); } });
  await q.call();
  await q.call();
  assert.equal(q.counter.n, 2);
});

test('reads are cached; a successful write in the session bumps the epoch', async () => {
  const reads = { n: 0 };
  const runner = createToolRunner([
    { name: 'peek', description: 'p', params: {}, effect: 'read', async run() { reads.n++; return 'v'; } },
    { name: 'poke', description: 'p', params: {}, effect: 'write', async run() { return 'ok'; } },
  ]);
  const ledger = createLedger({});
  const c = (over = {}) => ({ turn: { tainted: false }, ledger, sessionId: 's1', turnId: 't1', ...over });
  await runner.run('peek', {}, c());
  const hit = await runner.run('peek', {}, c({ turnId: 't2' }));
  assert.equal(hit.ledger, 'cached');
  assert.equal(reads.n, 1);
  await runner.run('poke', {}, c());
  await runner.run('peek', {}, c());
  assert.equal(reads.n, 2);
});

test('a volatile read is served only within the same turn', async () => {
  const reads = { n: 0 };
  const runner = createToolRunner([{ name: 'now', description: 'n', params: {}, effect: 'read', volatile: true, async run() { reads.n++; return 't'; } }]);
  const ledger = createLedger({});
  const c = turnId => ({ turn: { tainted: false }, ledger, sessionId: 's1', turnId });
  await runner.run('now', {}, c('a'));
  await runner.run('now', {}, c('a'));
  assert.equal(reads.n, 1);
  await runner.run('now', {}, c('b'));
  assert.equal(reads.n, 2);
});

test('an untrusted tool keeps untrusted on a cached result', async () => {
  const r = rig({ effect: 'read', untrusted: true, async run() { return 'page'; } });
  await r.call();
  const b = await r.call();
  assert.equal(b.ledger, 'cached');
  assert.equal(b.untrusted, true);
});

test('a confirm proposal is never recorded', async () => {
  const r = rig({ risk: 'confirm', async run() { r.counter.n++; return NEEDS_OK + 'send it?'; } });
  await r.call();
  await r.call();
  assert.equal(r.counter.n, 2);
});

test('refusals are denied and never reach the ledger; a guest is never served from it', async () => {
  const r = rig({ risk: 'confirm', async run() { r.counter.n++; return 'done'; } });
  const refused = await r.call({}, { turn: { tainted: true } });
  assert.equal(refused.denied, true);
  const g = await r.call({}, { turn: { tainted: true, speaker: 'guest' } });
  assert.equal(g.denied, true);
  assert.equal(r.counter.n, 0);
  const gt = rig({ name: 'get_time', effect: 'read', async run() { gt.counter.n++; return 'noon'; } });
  await gt.runner.run('get_time', {}, gt.ctx());
  const guest = await gt.runner.run('get_time', {}, gt.ctx({ turn: { tainted: true, speaker: 'guest' } }));
  assert.equal(guest.ledger, undefined);
  assert.equal(gt.counter.n, 2);
});

test('sessions are capped, oldest out', () => {
  const l = createLedger({ maxSessions: 2 });
  for (const s of ['a', 'b', 'c']) l.record(s, 'x', {}, { effect: 'read', ok: true, text: 't', turnId: 't' });
  assert.equal(l.check('a', 'x', {}, { effect: 'read', turnId: 't' }), null);
  assert.ok(l.check('c', 'x', {}, { effect: 'read', turnId: 't' }));
});

function orc(provider, ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-led-'));
  const bus = createBus();
  const events = [];
  bus.on('*', ev => events.push(ev));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(provider);
  const ran = [];
  const tools = createToolRunner([{ name: 'get_time', description: 't', params: {}, async run() { ran.push(1); return 'NOON'; } }]);
  const o = createOrchestrator({ bus, sessions, providers, tools, getConfig: () => ({ ...DEFAULTS, provider: provider.id }), ...(ledger ? { ledger } : {}) });
  const s = sessions.create(); sessions.save(s);
  return { o, s, events, ran, sessions };
}
const twice = () => createFakeProvider([
  [{ type: 'tool_call', id: 'a', name: 'get_time', args: {} }, { type: 'done' }],
  [{ type: 'tool_call', id: 'b', name: 'get_time', args: {} }, { type: 'done' }],
  [{ type: 'token', text: 'noon' }, { type: 'done' }],
]);

test('orchestrator with a ledger: the repeat gets the ledger text and a skipped event', async () => {
  const { o, s, events, ran, sessions } = orc(twice(), createLedger({}));
  await o.send(s.id, 'time?', { source: 'text' });
  assert.equal(ran.length, 1);
  const tool = sessions.load(s.id).messages.filter(m => m.role === 'tool');
  assert.equal(tool[1].content, 'NOON');   // a cached read is the tool's own text
  assert.equal(events.filter(e => e.type === 'tool' && e.phase === 'end')[1].skipped, true);
});

test('orchestrator without a ledger keeps the old duplicate text', async () => {
  const { o, s, ran, sessions } = orc(twice());
  await o.send(s.id, 'time?', { source: 'text' });
  assert.equal(ran.length, 1);
  assert.match(sessions.load(s.id).messages.filter(m => m.role === 'tool')[1].content, /you already made this exact call/);
});

test('soft failures are not recorded: the retry runs again', async () => {
  const r = rig({ async run() { r.counter.n++; return 'Could not find that window'; } });
  await r.call();
  const b = await r.call();
  assert.equal(r.counter.n, 2);
  assert.equal(b.ledger, undefined);
});

test('a cached read returns its raw text', async () => {
  const reads = { n: 0 };
  const runner = createToolRunner([{ name: 'get_time', description: 't', params: {}, effect: 'read', direct: true, async run() { reads.n++; return 'NOON'; } }]);
  const ctx = { turn: { tainted: false }, ledger: createLedger({}), sessionId: 's1', turnId: 't1' };
  await runner.run('get_time', {}, ctx);
  const hit = await runner.run('get_time', {}, ctx);
  assert.equal(hit.text, 'NOON');
  assert.equal(hit.ledger, 'cached');
  assert.equal(reads.n, 1);
});

test('orchestrator never speaks a ledger hit as a direct reply', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'a', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'tool_call', id: 'b', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'fine' }, { type: 'done' }],
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-led-'));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider); providers.add(fp);
  const tools = createToolRunner([{ name: 'get_time', description: 't', params: {}, effect: 'read', direct: true, async run() { return 'NOON'; } }]);
  const o = createOrchestrator({ bus: createBus(), sessions, providers, tools, ledger: createLedger({}), getConfig: () => ({ ...DEFAULTS, provider: fp.id }) });
  const s = sessions.create(); sessions.save(s);
  const res = await o.send(s.id, 'time?', { source: 'text' });
  assert.ok(!/Already done/.test(res.reply));
});

test('writes differing only in case both run; reads differing only in case share an entry', async () => {
  const w = rig();
  await w.call({ text: 'Yes' });
  await w.call({ text: 'yes' });
  assert.equal(w.counter.n, 2);
  const r = rig({ effect: 'read', async run() { r.counter.n++; return 'v'; } });
  await r.call({ q: 'Paris' });
  await r.call({ q: 'paris' });
  assert.equal(r.counter.n, 1);
});

test('TTL boundary: exactly ttlMs still hits, ttlMs + 1 runs again', async () => {
  const r = rig();
  await r.call();
  r.clock.t += 60000;
  await r.call();
  assert.equal(r.counter.n, 1);
  r.clock.t += 1;
  await r.call();
  assert.equal(r.counter.n, 2);
});

test('entry cap evicts the oldest', () => {
  const l = createLedger({ maxPerSession: 2 });
  for (const q of ['a', 'b', 'c']) l.record('s', 'x', { q }, { effect: 'read', ok: true, text: 't', turnId: 't' });
  assert.equal(l.check('s', 'x', { q: 'a' }, { effect: 'read', turnId: 't' }), null);
  assert.ok(l.check('s', 'x', { q: 'c' }, { effect: 'read', turnId: 't' }));
});

test('ctx.fresh bypasses a hit', async () => {
  const r = rig();
  await r.call();
  await r.call({ to: 'a' }, { fresh: true });
  assert.equal(r.counter.n, 2);
});

test('no ledger in ctx: every call runs', async () => {
  const r = rig();
  await r.runner.run('send', { to: 'a' }, { turn: { tainted: false } });
  await r.runner.run('send', { to: 'a' }, { turn: { tainted: false } });
  assert.equal(r.counter.n, 2);
});

test('orchestrator: a guest turn with a ledger injected still uses the old duplicate guard', async () => {
  const { o, s, ran, sessions } = orc(twice(), createLedger({}));
  await o.send(s.id, 'time?', { source: 'text', speaker: 'guest' });
  assert.equal(ran.length, 1);
  assert.match(sessions.load(s.id).messages.filter(m => m.role === 'tool')[1].content, /you already made this exact call/);
});

test('orchestrator: the ledger is active in a scoped turn (groups, scopedRun)', async () => {
  const counter = { n: 0 };
  const groups = [{ id: 'g', label: 'G', triggers: [], tools: [{ name: 'send', description: 's', params: {}, effect: 'write', async run() { counter.n++; return 'sent'; } }] }];
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'a', name: 'send', args: {} }, { type: 'done' }],
    [{ type: 'tool_call', id: 'b', name: 'send', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'ok' }, { type: 'done' }],
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-led-'));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider); providers.add(fp);
  const o = createOrchestrator({
    bus: createBus(), sessions, providers, tools: createToolRunner(groups[0].tools, { groups }), ledger: createLedger({}),
    getConfig: () => ({ ...DEFAULTS, provider: fp.id }), selectGroups: () => ['g'],
    route: () => ({ tier: 'deep', think: false, tools: true, reason: 'test' }),
  });
  const s = sessions.create(); sessions.save(s);
  await o.send(s.id, 'send it', { source: 'text' });
  assert.equal(counter.n, 1);
  assert.match(sessions.load(s.id).messages.filter(m => m.role === 'tool')[1].content, /^Already done/);
});
