// A `tool` event for every tool call (W2 §2, plan E14): name, ok, ms, redacted args, the turn; no results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cortexOn } = require('./helpers/cortex');
const { createToolHistory, redactArgs } = require('../src/core/self/tool-history');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createFakeProvider } = require('./helpers/fake-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');

const DAY = 864e5;

test('tool-events: one event per call with name, ok, ms, args and turn', () => {
  const c = cortexOn();
  const h = createToolHistory({ cortex: c, now: () => 5000 });
  h.record({ name: 'get_time', ok: true, ms: 12, args: { zone: 'UTC' }, turn: (1_731_340_000_000).toString(36) });
  const [e] = c.event.query({ kind: 'tool' });
  assert.deepEqual(e.payload, { name: 'get_time', ok: true, ms: 12, args: { zone: 'UTC' }, turn: (1_731_340_000_000).toString(36) });
  assert.equal(e.at, 5000);
});

test('tool-events: args are capped, cut and redacted (Review Focus 5)', () => {
  const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['k' + i, i]));
  assert.equal(Object.keys(redactArgs(many)).length, 10);
  assert.equal(redactArgs({ q: 'x'.repeat(50000) }).q.length, 200);
  assert.deepEqual(redactArgs({ a: 'my password hunter2', b: 1234567890123, c: { nested: 'ok' }, d: 7 }), { a: '[hidden]', b: '[hidden]', c: '{"nested":"ok"}', d: '7' });
  assert.deepEqual(redactArgs(null), {});
  const c = cortexOn();
  createToolHistory({ cortex: c }).record({ name: 'web_search', ok: true, ms: 1, args: { query: 'my api key is abc', n: 1234567890123 } });
  assert.deepEqual(c.event.query({ kind: 'tool' })[0].payload.args, { query: '[hidden]', n: '[hidden]' });
});

test('tool-events: stats counts calls and fails since a time', () => {
  let t = 1000;
  const h = createToolHistory({ cortex: cortexOn(), now: () => t });
  h.record({ name: 'a', ok: true, ms: 1, args: {} });
  t = 5000;
  h.record({ name: 'a', ok: false, ms: 1, args: {} });
  h.record({ name: 'b', ok: true, ms: 1, args: {} });
  const s = h.stats({ since: 2000 });
  assert.deepEqual(s.get('a'), { calls: 1, fails: 1, lastAt: 5000 });
  assert.equal(h.stats({ since: 0 }).get('a').calls, 2);
  assert.equal(h.recent({ since: 0 }).length, 3);
});

test('tool-events: prune drops events older than 90 days', () => {
  let t = 0;
  const h = createToolHistory({ cortex: cortexOn(), now: () => t });
  h.record({ name: 'old', ok: true, ms: 1, args: {} });
  t = 91 * DAY;
  h.record({ name: 'new', ok: true, ms: 1, args: {} });
  assert.equal(h.prune(), 1);
  assert.deepEqual(h.recent({ since: 0 }).map(e => e.name), ['new']);
});

function setup(provider, orc = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-tev-'));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider); providers.add(provider);
  const tools = createToolRunner([{ name: 'get_time', description: 't', params: {}, async run() { return 'NOON'; } }]);
  const o = createOrchestrator({ bus: createBus(), sessions, providers, tools, getConfig: () => ({ ...DEFAULTS, provider: provider.id }), ...orc });
  const s = sessions.create(); sessions.save(s);
  return { orc: o, s };
}

test('orchestrator: onToolCall fires per model tool call and for a fast-path skill', async () => {
  const seen = [];
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'get_time', args: { zone: 'UTC' } }, { type: 'done' }],
    [{ type: 'token', text: 'It is noon.' }, { type: 'done' }],
  ]);
  const fastPath = async text => (text === 'pause' ? { reply: 'Paused.', tool: 'media_control', ok: true } : null);
  const { orc, s } = setup(fp, { onToolCall: e => seen.push(e), fastPath });
  await orc.send(s.id, 'what time is it', { source: 'text' });
  await orc.send(s.id, 'pause', { source: 'text' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].name, 'get_time'); assert.equal(seen[0].ok, true); assert.deepEqual(seen[0].args, { zone: 'UTC' });
  assert.ok(Number.isFinite(seen[0].ms)); assert.match(seen[0].turn, /^[0-9a-z]+$/);
  assert.deepEqual({ name: seen[1].name, ok: seen[1].ok, args: seen[1].args }, { name: 'media_control', ok: true, args: {} });
});

test('orchestrator: a throwing onToolCall leaves the turn intact', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'It is noon.' }, { type: 'done' }],
  ]);
  const { orc, s } = setup(fp, { onToolCall: () => { throw new Error('disk full'); } });
  const r = await orc.send(s.id, 'what time is it', { source: 'text' });
  assert.equal(r.reply, 'It is noon.');
});

test('tool-events: a youtube_music call with a secret flag is recorded (the key is hidden, not the event lost)', () => {
  const c = cortexOn();
  createToolHistory({ cortex: c }).record({ name: 'youtube_music', ok: true, ms: 5, args: { action: 'play', query: 'abba', secret: false } });
  const [e] = c.event.query({ kind: 'tool' });
  assert.ok(e, 'event written');
  assert.equal(e.payload.args.action, 'play');
  assert.ok(!JSON.stringify(e.payload).match(/secret/i));
});
