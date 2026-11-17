const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createBusLink, createMemoryLink } = require('../src/core/stockman/jarvis/link');
const { describeHealth } = require('../src/core/stockman/jarvis/tools');
const { createBus } = require('../src/core/bus');
const { loadGroups } = require('../src/core/skills');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createStaticSecrets } = require('../src/core/stockman/secrets');
const E = require('../src/core/stockman/errors');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-app-'));
function make(over = {}) {
  const lines = [];
  const app = createStockman({
    env: {}, dataDir: tmpDir(), dbFile: ':memory:', log: l => lines.push(l),
    provider: createMockProvider({ quotes: { ABC: 10 } }),
    sleep: async () => {}, ...over,
  });
  return { app, lines };
}

test('stockman-app: start opens the database, writes meta, tells jarvis it is ready; stop closes it', async () => {
  const link = createMemoryLink();
  const { app } = make({ link });
  await app.start();
  assert.equal(app.db.version, 1);
  assert.equal(app.db.stmt("SELECT value FROM meta WHERE key = 'framework_version'").get().value, '1');
  assert.equal(link.events[0].topic, 'ready');
  const h = app.health();
  assert.equal(h.started, true);
  assert.equal(h.db.ok, true);
  assert.equal(h.stocks.provider, 'mock');
  await app.stop();
  assert.equal(app.db, null);
  assert.equal(link.events.at(-1).topic, 'stopped');
  assert.equal(app.health().started, false);
});

test('stockman-app: warnings and errors are copied into engine_event, secrets redacted', async () => {
  const secret = 'test-value-9999';
  const { app } = make({ secrets: createStaticSecrets({ DEMO_KEY: secret }) });
  await app.start();
  app.log.info('only on the console');
  app.log.warn(`provider said no, key ${secret}`, { token: 'zzz' });
  const rows = app.events.recent({ source: 'app' });
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(secret));
  await app.stop();
});

test('stockman-app: a switched-off StockMan does not open anything', async () => {
  const { app, lines } = make({ overrides: { enabled: false } });
  await app.start();
  assert.equal(app.db, null);
  assert.equal(app.health().started, false);
  assert.ok(lines.some(l => /switched off/.test(l)));
});

test('stockman-app: a feature plugs in with its own migration, tool, start and stop, and sees the framework services', async () => {
  const order = [];
  const feature = {
    id: 'demo',
    migrations: [{ version: 2, name: 'demo-table', up: raw => raw.exec('CREATE TABLE demo_item(id INTEGER PRIMARY KEY, symbol TEXT)') }],
    async start(ctx) { order.push('start'); ctx.db.stmt('INSERT INTO demo_item(symbol) VALUES (?)').run('ABC'); assert.ok(ctx.stocks && ctx.link && ctx.events && ctx.log); },
    async stop() { order.push('stop'); },
    tools: ctx => [{ name: 'stockman_demo', description: 'demo', params: { type: 'object', properties: {}, additionalProperties: false }, run: async () => String(ctx.db.stmt('SELECT COUNT(*) AS n FROM demo_item').get().n) }],
  };
  const { app } = make();
  app.use(feature);
  await app.start();
  assert.equal(app.db.version, 2);
  const tools = app.tools();
  assert.deepEqual(tools.map(t => t.name), ['stockman_status', 'stockman_demo']);
  assert.equal(await tools[1].run(), '1');
  assert.deepEqual(app.health().features, ['demo']);
  await app.stop();
  assert.deepEqual(order, ['start', 'stop']);
});

test('stockman-app: feature registration is checked', async () => {
  const { app } = make();
  assert.throws(() => app.use({}), /needs an id/);
  assert.throws(() => app.use({ id: 'Bad Id' }), /needs an id/);
  assert.throws(() => app.use({ id: 'ok', start: 'no' }), /start must be a function/);
  app.use({ id: 'one' });
  assert.throws(() => app.use({ id: 'one' }), /already registered/);
  app.use({ id: 'wrong-tool', tools: () => [{ name: 'get_weather' }] });
  await app.start();
  assert.throws(() => app.tools(), /must start with "stockman_"/);
  assert.throws(() => app.use({ id: 'late' }), /before start/);
  await app.stop();
});

test('stockman-app: a bad feature migration or a failing feature start stops the app loudly and cleans up', async () => {
  const a = make().app;
  a.use({ id: 'clash', migrations: [{ version: 1, name: 'clash', up: () => {} }] });
  await assert.rejects(a.start(), E.MigrationError);

  const stopped = [];
  const b = make().app;
  b.use({ id: 'good', stop: async () => { stopped.push('good'); } });
  b.use({ id: 'broken', start: async () => { throw new Error('cannot start'); } });
  await assert.rejects(b.start(), /cannot start/);
  assert.deepEqual(stopped, ['good']);
  assert.equal(b.db, null);
});

test('stockman-app: the jarvis bus link emits one typed event, and subscribers see only their topic', () => {
  const bus = createBus();
  const seen = [], all = [];
  bus.on('*', e => all.push(e));
  const link = createBusLink({ bus });
  const off = link.subscribe('circuit', e => seen.push(e.state));
  link.publish('circuit', { state: 'open' });
  link.publish('ready');
  assert.deepEqual(seen, ['open']);
  assert.deepEqual(all.map(e => [e.type, e.topic]), [['stockman', 'circuit'], ['stockman', 'ready']]);
  off(); link.publish('circuit', { state: 'closed' });
  assert.deepEqual(seen, ['open']);
  assert.throws(() => link.publish('Bad Topic'), /bad topic/);
  assert.throws(() => createBusLink({ bus: {} }), TypeError);
});

test('stockman-app: when the circuit opens, jarvis is told through the link', async () => {
  const link = createMemoryLink();
  const provider = createMockProvider({ quotes: { ABC: 1 } });
  provider.failNext(new E.TransientError('down'), 100);
  const { app } = make({ link, provider, overrides: { provider: { retries: 0, breakerFailures: 2 } } });
  await app.start();
  for (let i = 0; i < 2; i++) await app.stocks.getQuote('ABC').catch(() => {});
  assert.ok(link.events.some(e => e.topic === 'circuit' && e.state === 'open'));
  await app.stop();
});

test('stockman-app: stockman_status reports plainly, before and after start', async () => {
  const { app } = make();
  const tool = app.tools()[0];
  assert.match(await tool.run(), /not started/);
  await app.start();
  await app.stocks.getQuote('ABC');
  const text = await tool.run();
  assert.match(text, /database ok \(schema v1\)/);
  assert.match(text, /circuit closed/);
  assert.match(text, /1 call, 0 failed/);
  assert.match(describeHealth({ started: true, db: { ok: false }, stocks: { provider: 'x', breaker: { state: 'open' }, calls: 0, failures: 0, lastOkAt: null, lastError: { message: 'boom' } }, features: [] }), /NOT ok.*circuit open.*none succeeded.*boom/);
  await app.stop();
});

test('stockman-app: the jarvis skill group appears only when a stockman dependency is given', async () => {
  const without = loadGroups({});
  assert.ok(without.missing.some(m => m.id === 'stockman' && !m.error));
  const { app } = make();
  await app.start();
  const groups = loadGroups({ stockman: app });
  const g = groups.find(x => x.id === 'stockman');
  assert.ok(g, 'group loaded');
  assert.deepEqual(g.tools.map(t => t.name), ['stockman_status']);
  assert.equal(g.status().ok, true);
  await app.stop();
});

test('stockman-app: the whole stack works through the real fetcher with the network mocked, and secrets are never needed', async () => {
  const chart = require('./fixtures/stockman-chart.json');
  const { app } = make({ provider: undefined, fetch: async () => new Response(JSON.stringify(chart), { status: 200 }) });
  await app.start();
  assert.equal(app.health().stocks.provider, 'yahoo');
  const q = await app.stocks.getQuote('ABC');
  assert.equal(q.price, 104.5);
  await app.stop();
});
