const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createBus } = require('../src/core/bus');
const { createStore, dayKey } = require('../src/core/metrics/store');
const { summarize, describe } = require('../src/core/metrics/aggregate');
const { createMetrics } = require('../src/core/metrics/collector');
const { createAnalyticsTools } = require('../src/core/tools/analytics');
const { startBridge } = require('../src/core/bridge');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-metrics-'));
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);

test('store: events are batched to day files, read back by range, and a corrupt line is skipped', () => {
  const dir = tmp();
  let now = T0;
  const s = createStore({ dir, now: () => now, flushMs: 10 });
  s.add({ t: T0 - 864e5, k: 'turn', ms: 100 });   // yesterday
  s.add({ t: T0, k: 'turn', ms: 200 });
  s.add({ t: T0 + 1000, k: 'tool', name: 'x', ok: true });
  assert.equal(s.read(T0 - 2 * 864e5, T0 + 5000).length, 3, 'buffered events are readable before they are flushed');
  s.flush();
  assert.deepEqual(fs.readdirSync(dir).sort(), [dayKey(T0 - 864e5) + '.jsonl', dayKey(T0) + '.jsonl']);
  fs.appendFileSync(path.join(dir, dayKey(T0) + '.jsonl'), '{"t": 12, "k": "tu\n{not json}\n');   // torn and corrupt lines
  const got = s.read(T0 - 1000, T0 + 5000);
  assert.deepEqual(got.map(e => e.k), ['turn', 'tool']);
  assert.equal(s.read(T0 - 2 * 864e5, T0 - 864e5 + 10).length, 1);
  assert.equal(s.stats().written, 3);
  s.close();
});

test('store: day files older than the retention are removed', () => {
  const dir = tmp();
  let now = T0;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), '{"t":1,"k":"turn"}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  const s = createStore({ dir, now: () => now, maxDays: 30 });
  s.add({ k: 'turn', ms: 1 });
  s.flush();
  assert.ok(!fs.existsSync(path.join(dir, '2026-01-01.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'only its own day files');
  s.close();
});

test('store: a folder that cannot be created drops events instead of throwing', () => {
  const file = path.join(tmp(), 'a-file');
  fs.writeFileSync(file, 'x');
  const s = createStore({ dir: path.join(file, 'inside'), now: () => T0 });
  s.add({ k: 'turn' });
  assert.doesNotThrow(() => s.flush());
  assert.equal(s.stats().dropped, 1);
});

const ev = (t, o) => ({ t: T0 - 3600e3 + t * 1000, ...o });
const EVENTS = [
  ev(1, { k: 'turn', source: 'voice', tier: 'deep', ms: 2000, tps: 30, promptTokens: 100, completionTokens: 20 }),
  ev(2, { k: 'turn', source: 'text', tier: 'fast', ms: 600, promptTokens: 50, completionTokens: 10 }),
  ev(3, { k: 'turn', source: 'text', tier: 'deep', ms: 4000 }),
  ev(4, { k: 'tool', name: 'get_weather', group: 'knowledge', ok: true, ms: 300 }),
  ev(5, { k: 'tool', name: 'get_weather', group: 'knowledge', ok: false, ms: 500 }),
  ev(6, { k: 'tool', name: 'media_control', group: 'media', ok: true, ms: 80, soft: 1 }),
  ev(7, { k: 'tool', name: 'set_timer', group: 'timers', ok: false, ms: 5, bad: 1 }),
  ev(8, { k: 'clarify', kind: 'ask' }), ev(9, { k: 'clarify', kind: 'decline' }),
  ev(10, { k: 'ytprompt', kind: 'still-listening', confirmed: true }), ev(11, { k: 'ytprompt', kind: 'age-confirm', confirmed: false }),
  ev(12, { k: 'err', where: 'turn' }), ev(13, { k: 'warn', text: 'x' }), ev(14, { k: 'route', tier: 'skill' }),
  ev(20, { k: 'sample', rssMB: 100, heapMB: 40, cortexNodes: 10, cortexBytes: 1000, svc: { ollama: true, ytmusic: true } }),
  ev(80, { k: 'sample', rssMB: 110, heapMB: 42, cortexNodes: 12, cortexBytes: 1200, svc: { ollama: true, ytmusic: false } }),
  ev(30, { k: 'conn', service: 'ytmusic', up: false }), ev(40, { k: 'conn', service: 'ytmusic', up: true }),
];
const RANGE = { from: T0 - 3600e3, to: T0 };

test('aggregate: totals, latency percentiles, skill rows, clarify, prompts, connections, memory', () => {
  const s = summarize(EVENTS, RANGE);
  assert.equal(s.totals.turns, 3);
  assert.deepEqual(s.totals.bySource, { voice: 1, text: 2 });
  assert.equal(s.totals.p50TurnMs, 2000);
  assert.equal(s.totals.toolCalls, 4);
  assert.equal(s.totals.toolSuccessRate, 50);
  assert.equal(s.totals.softFails, 1); assert.equal(s.totals.badArgs, 1);
  assert.deepEqual(s.totals.clarify, { ask: 1, decline: 1 });
  assert.deepEqual(s.totals.prompts, { confirmed: 1, skipped: 1 });
  assert.equal(s.totals.errors, 1); assert.equal(s.totals.fastPath, 1);
  const w = s.tools.find(r => r.name === 'get_weather');
  assert.deepEqual([w.calls, w.ok, w.fail, w.successRate, w.avgMs], [2, 1, 1, 50, 400]);
  assert.deepEqual(s.connections.ytmusic, { upPct: 50, samples: 2, drops: 1, reconnects: 1 });
  assert.equal(s.connections.ollama.upPct, 100);
  assert.deepEqual(s.memory.latest, { rssMB: 110, heapMB: 42, cortexNodes: 12, cortexBytes: 1200, plays: null });
  assert.equal(s.memory.growthPerDay.rssMB, null, 'two samples a minute apart say nothing about a day');
  const week = summarize([{ t: T0 - 2 * 864e5, k: 'sample', rssMB: 100, cortexBytes: 1000, cortexNodes: 10 }, { t: T0, k: 'sample', rssMB: 120, cortexBytes: 3000, cortexNodes: 50 }], { from: T0 - 3 * 864e5, to: T0 });
  assert.deepEqual(week.memory.growthPerDay, { rssMB: 10, cortexBytes: 1000, cortexNodes: 20 });
  assert.deepEqual(s.filters.groups, ['knowledge', 'media', 'timers']);
  assert.equal(s.series.turns.reduce((a, b) => a + b, 0), 3);
  assert.equal(s.series.t.length, s.series.turns.length);
});

test('aggregate: filters narrow skill rows and turns', () => {
  const g = summarize(EVENTS, { ...RANGE, group: 'knowledge' });
  assert.equal(g.totals.toolCalls, 2); assert.deepEqual(g.tools.map(r => r.name), ['get_weather']);
  assert.equal(summarize(EVENTS, { ...RANGE, tool: 'set_timer' }).totals.toolCalls, 1);
  const v = summarize(EVENTS, { ...RANGE, source: 'voice' });
  assert.equal(v.totals.turns, 1); assert.equal(v.totals.p50TurnMs, 2000);
  assert.equal(summarize(EVENTS, { from: T0 + 1, to: T0 + 100 }).totals.turns, 0, 'outside the range');
});

test('aggregate: buckets follow the range, an empty range is fine', () => {
  const day = summarize([], { from: T0 - 864e5, to: T0 });
  assert.ok(day.series.t.length >= 24 && day.series.t.length <= 120);
  assert.equal(summarize([], RANGE).totals.toolSuccessRate, null);
  assert.equal(describe(summarize([], RANGE)), 'Nothing recorded in that period yet.');
  assert.match(describe(summarize(EVENTS, RANGE)), /3 conversation turns.*4 skill calls, 50% succeeded/);
});

test('collector: bus events become metrics (tool timing, no text), and the sampler adds memory and connections', async () => {
  const bus = createBus();
  let now = T0;
  const m = createMetrics({ dir: tmp(), bus, now: () => now, groupOf: n => (n === 'get_weather' ? 'knowledge' : null), sample: () => ({ cortexNodes: 5, svc: { ollama: true } }), usage: () => ({ rss: 200 * 1048576, heapUsed: 50 * 1048576 }) });
  bus.emit('tool', { id: 'a', name: 'get_weather', label: 'get_weather · “my secret town”', phase: 'start' });
  now += 250;
  bus.emit('tool', { id: 'a', name: 'get_weather', phase: 'end', ok: true });
  bus.emit('tool', { id: 'b', name: 'media_control', phase: 'end', ok: false, soft: undefined, badArgs: true });
  bus.emit('turn', { source: 'voice', tier: 'deep', ms: 1200, promptTokens: 9, completionTokens: 3, toolRounds: 1 });
  bus.emit('clarify', { kind: 'ask', reason: 'bare pronoun' });
  bus.emit('ytprompt', { kind: 'still-listening', confirmed: true });
  bus.emit('state', { state: 'error', detail: 'Model timed out' });
  bus.emit('log', { level: 'warn', text: 'Memory recall failed: x' });
  bus.emit('provider', { id: 'ollama', ready: true }); bus.emit('provider', { id: 'ollama', ready: true }); bus.emit('provider', { id: 'ollama', ready: false });
  m.sampleNow();
  const s = m.query({ from: T0 - 1000, to: T0 + 10000 });
  assert.equal(s.totals.turns, 1); assert.equal(s.totals.errors, 1); assert.equal(s.totals.warnings, 1);
  const w = s.tools.find(r => r.name === 'get_weather');
  assert.deepEqual([w.group, w.calls, w.avgMs], ['knowledge', 1, 250]);
  assert.equal(s.tools.find(r => r.name === 'media_control').badArgs, 1);
  assert.equal(s.totals.clarify.ask, 1); assert.equal(s.totals.prompts.confirmed, 1);
  assert.deepEqual(s.memory.latest.rssMB, 200); assert.equal(s.memory.latest.cortexNodes, 5);
  assert.equal(s.connections.ollama.drops, 1, 'only a change of state is a connection event');
  assert.ok(!JSON.stringify(m.query({ from: 0, to: T0 + 1e6 })).includes('secret town'), 'no query text is stored');
  assert.equal(m.stats().openTools, 0, 'no call left open');
  m.close();
});

test('collector: a tool call that never ends cannot grow the open-call list without limit', () => {
  const bus = createBus();
  const m = createMetrics({ dir: tmp(), bus });
  for (let i = 0; i < 1000; i++) bus.emit('tool', { id: 'x' + i, name: 'slow', phase: 'start' });
  assert.ok(m.stats().openTools <= 200);
  m.close();
});

test('tools: analytics_summary says how he has been doing, open_dashboard opens the page', async () => {
  const opened = [];
  const bus = createBus();
  const m = createMetrics({ dir: tmp(), bus });
  bus.emit('turn', { source: 'text', tier: 'deep', ms: 900 });
  const [summary, dash] = createAnalyticsTools({ metrics: m, openDashboard: async o => { opened.push(o); return 'http://127.0.0.1:1/ai/dashboard'; } });
  assert.match(await summary.run({ range: 'week' }), /^Last week: 1 conversation turn/);
  assert.match(await summary.run({ range: 'nonsense' }), /^Last day/);
  assert.match(await dash.run({ range: 'hour' }), /Opened the dashboard/);
  assert.deepEqual(opened, [{ range: 'hour' }]);
  const none = createAnalyticsTools({ metrics: m, openDashboard: async () => null })[1];
  await assert.rejects(none.run({}), /not running/);
  assert.deepEqual(createAnalyticsTools({}), []);
  m.close();
});

test('bridge: the dashboard page and numbers are served to this page only, with a strict content policy', async () => {
  const bus = createBus();
  let seen = null;
  const files = { html: Buffer.from('<html>ok</html>'), js: Buffer.from('//js'), css: Buffer.from('/*css*/') };
  const bridge = await startBridge({ bus, version: 't', ports: [47970, 47971, 47972], dashboard: { query: o => { seen = o; return { hello: 1 }; }, files } });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: bridge.port, path: p, headers }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
  });
  try {
    const page = await get('/ai/dashboard');
    assert.equal(page.status, 200); assert.equal(page.body, '<html>ok</html>');
    assert.match(page.headers['content-security-policy'], /default-src 'none'.*script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get('/ai/dashboard.js')).body, '//js');
    const m = await get('/ai/metrics?range=week&group=media&tool=' + 'x'.repeat(100));
    assert.deepEqual(JSON.parse(m.body), { hello: 1 });
    assert.equal(seen.group, 'media'); assert.equal(seen.tool, null, 'an over-long filter is ignored');
    assert.ok(seen.to - seen.from === 7 * 864e5, 'range=week');
    assert.equal((await get('/ai/metrics', { Origin: 'http://localhost:9999' })).status, 403, 'another local page cannot read it');
    assert.equal((await get('/ai/metrics', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await get('/ai/metrics', { Origin: `http://127.0.0.1:${bridge.port}` })).status, 200, 'the page itself can');
    assert.equal((await get('/ai/dashboard', { Host: 'evil.example' })).status, 403, 'DNS rebinding');
  } finally { await bridge.close(); }
});

test('bridge: without a dashboard the routes do not exist', async () => {
  const bridge = await startBridge({ bus: createBus(), version: 't', ports: [47973, 47974] });
  const r = await new Promise(res => http.get({ host: '127.0.0.1', port: bridge.port, path: '/ai/metrics' }, x => { x.resume(); res(x.statusCode); }));
  assert.equal(r, 404);
  await bridge.close();
});
