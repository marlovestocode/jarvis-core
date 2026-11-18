const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStockmanProcess } = require('../src/core/stockman/process');
const { createBus } = require('../src/core/bus');
const { describeHealth } = require('../src/core/stockman/jarvis/tools');
const { StockmanError } = require('../src/core/stockman/errors');

const HEALTH = { started: true, enabled: true, db: { ok: true, version: 1, file: 'x' }, stocks: { provider: 'mock', breaker: { state: 'closed' }, limiter: {}, calls: 0, failures: 0, lastOkAt: null, lastError: null }, features: [] };
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await tick(5); } };

// a fake child process; `script(child, index)` decides how it behaves (default: ready as soon as it gets init)
function fakeFork(script = (c) => { c.autoReady = true; }) {
  const children = [];
  const fork = () => {
    const c = new EventEmitter();
    Object.assign(c, { pid: 4000 + children.length, sent: [], stdout: new EventEmitter(), stderr: new EventEmitter(), autoReady: false, autoStop: true });
    c.send = m => {
      c.sent.push(m);
      if (m.type === 'init' && c.autoReady) setImmediate(() => c.emit('message', { type: 'ready', health: HEALTH }));
      if (m.type === 'stop' && c.autoStop) setImmediate(() => c.emit('exit', 0, null));
      if (m.type === 'request' && c.onRequest) c.onRequest(m);
    };
    c.kill = () => setImmediate(() => c.emit('exit', null, 'SIGTERM'));
    c.reply = (m, result) => c.emit('message', { type: 'reply', id: m.id, ok: true, result });
    children.push(c);
    script(c, children.length - 1);
    return c;
  };
  return { fork, children };
}
const make = (script, over = {}) => {
  const f = fakeFork(script), lines = [], bus = createBus(), events = [];
  bus.on('stockman', e => events.push(e.topic));
  const engine = createStockmanProcess({ fork: f.fork, bus, log: l => lines.push(l), dataDir: '/data', getConfig: () => ({ online: { enabled: true, finance: true } }), startTimeoutMs: 300, requestTimeoutMs: 200, stopTimeoutMs: 100, restart: { baseMs: 5, maxMs: 20, maxRestarts: 2, resetAfterMs: 60000 }, ...over });
  return { engine, ...f, lines, events };
};

test('stockman-process: start waits for ready, sends init with the data folder and online switch, and caches health', async () => {
  const { engine, children } = make();
  await engine.start();
  assert.deepEqual(children[0].sent[0], { type: 'init', dataDir: '/data', online: { enabled: true, finance: true } });
  const h = engine.health();
  assert.equal(h.started, true);
  assert.equal(h.process.state, 'running');
  assert.equal(h.process.pid, 4000);
  assert.equal(h.stocks.provider, 'mock');
  assert.match(await engine.tools()[0].run(), /database ok.*circuit closed/);
  await engine.stop();
  assert.equal(engine.health().process.state, 'stopped');
  assert.equal(engine.health().started, false);
});

test('stockman-process: worker events reach jarvis\'s bus, logs reach the log, health pushes update the cache', async () => {
  const { engine, children, events, lines } = make();
  await engine.start();
  const c = children[0];
  c.emit('message', { type: 'event', topic: 'circuit', payload: { state: 'open' } });
  c.emit('message', { type: 'event', topic: 'Bad Topic', payload: {} });   // refused by the link, must not throw
  c.emit('message', { type: 'log', line: 'hello from worker' });
  c.stderr.emit('data', 'stack line\n');
  c.emit('message', { type: 'health', health: { ...HEALTH, stocks: { ...HEALTH.stocks, calls: 9 } } });
  assert.deepEqual(events, ['circuit']);
  assert.ok(lines.includes('hello from worker'));
  assert.ok(lines.some(l => /stockman err: stack line/.test(l)));
  assert.equal(engine.health().stocks.calls, 9);
  await engine.stop();
});

test('stockman-process: request round trip, errors keep their code, timeouts and a stopped engine reject', async () => {
  const { engine, children } = make();
  await assert.rejects(engine.request('health'), /engine is stopped/);
  await engine.start();
  const c = children[0];
  c.onRequest = m => {
    if (m.op === 'quote') c.reply(m, { symbol: m.args.symbol, price: 1 });
    else if (m.op === 'history') c.emit('message', { type: 'reply', id: m.id, ok: false, error: { code: 'NOT_FOUND', message: 'no data', retryable: false } });
    /* any other op: no answer */
  };
  assert.deepEqual(await engine.request('quote', { symbol: 'ABC' }), { symbol: 'ABC', price: 1 });
  const err = await engine.request('history', {}).catch(e => e);
  assert.ok(err instanceof StockmanError);
  assert.equal(err.code, 'NOT_FOUND');
  await assert.rejects(engine.request('events'), /did not answer events within 200 ms/);
  await engine.stop();
});

test('stockman-process: a change to jarvis\'s online switch is pushed to the worker before the next request, and only once', async () => {
  let online = { enabled: true, finance: true };
  const { engine, children } = make(undefined, { getConfig: () => ({ online }) });
  await engine.start();
  const c = children[0];
  c.onRequest = m => c.reply(m, 1);
  const pushes = () => c.sent.filter(m => m.type === 'online');
  await engine.request('health');
  assert.equal(pushes().length, 1);   // the first sync after ready
  await engine.request('health');
  assert.equal(pushes().length, 1);   // unchanged: nothing sent
  online = { enabled: true, finance: false };
  await engine.request('health');
  assert.deepEqual(pushes().at(-1).online, { enabled: true, finance: false });
  await engine.stop();
});

test('stockman-process: a crash restarts the worker, tells jarvis, and fails requests that were waiting', async () => {
  const { engine, children, events } = make();
  await engine.start();
  const waiting = engine.request('health').catch(e => e);
  children[0].emit('exit', 1, null);
  assert.match((await waiting).message, /engine process ended/);
  assert.equal(engine.health().process.state, 'restarting');
  assert.match(describeHealth(engine.health()), /engine is restarting/);
  await until(() => engine.health().process.state === 'running');
  assert.equal(children.length, 2);
  assert.equal(engine.health().process.restarts, 1);
  assert.deepEqual(events, ['engine-down', 'engine-up']);
  await engine.stop();
});

test('stockman-process: after maxRestarts quick crashes it gives up, says why, and stops trying', async () => {
  const { engine, children, events } = make((c, i) => { if (i === 0) c.autoReady = true; else c.autoReady = false; c.autoStop = true; /* later children die before ready */ setImmediate(() => { if (i > 0) c.emit('exit', 1, null); }); });
  await engine.start();
  children[0].emit('exit', 1, null);
  await until(() => engine.health().process.state === 'failed');
  assert.equal(children.length, 3);                     // the first plus maxRestarts (2) restarts
  assert.match(engine.health().process.failReason, /crashed 2 times/);
  assert.match(describeHealth(engine.health()), /engine is failed \(crashed 2 times/);
  assert.ok(events.includes('engine-failed'));
  await tick(60);
  assert.equal(children.length, 3);                     // no further attempts
  await engine.stop();
});

test('stockman-process: a worker that cannot start (fatal, exit code 2) fails start() with the reason and is not restarted', async () => {
  const f = fakeFork(c => { const orig = c.send; c.send = m => { orig(m); if (m.type === 'init') setImmediate(() => { c.emit('message', { type: 'fatal', error: 'migration failed' }); c.emit('exit', 2, null); }); }; });
  const e = createStockmanProcess({ fork: f.fork, dataDir: '/d', startTimeoutMs: 300 });
  await assert.rejects(e.start(), /could not start: migration failed/);
  assert.equal(e.health().process.state, 'failed');
  await tick(30);
  assert.equal(f.children.length, 1);
});

test('stockman-process: a worker that never says ready times out and is killed', async () => {
  const { engine, children } = make(() => {}, { startTimeoutMs: 40 });
  await assert.rejects(engine.start(), /did not become ready within 40 ms/);
  await tick(20);
  assert.equal(engine.health().process.state, 'failed');
  assert.equal(children.length, 1);
});

test('stockman-process: stop asks politely, then kills a worker that will not leave, and rejects waiting requests', async () => {
  const { engine, children } = make();
  await engine.start();
  children[0].autoStop = false;                         // ignores the stop message
  const waiting = engine.request('health').catch(e => e);
  await engine.stop();                                  // stopTimeoutMs 100 → kill → exit
  assert.ok(children[0].sent.some(m => m.type === 'request' && m.op === 'health'));
  assert.ok(children[0].sent.some(m => m.type === 'stop'));
  assert.match((await waiting).message, /engine (process ended|stopped)/);
  assert.equal(engine.health().process.state, 'stopped');
  await tick(30);
  assert.equal(children.length, 1);                     // a stop is never a crash: no restart
});

// ---- the real worker, in a real child process ----
test('stockman-process: the real worker starts, answers, survives being killed, and stops', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-proc-'));
  const bus = createBus(), events = [];
  bus.on('stockman', e => events.push(e.topic));
  const engine = createStockmanProcess({ bus, dataDir, env: { ...process.env, STOCKMAN_PROVIDER: 'mock' }, getConfig: () => ({ online: { enabled: true, finance: true } }), startTimeoutMs: 15000, restart: { baseMs: 50, maxMs: 200, maxRestarts: 3, resetAfterMs: 60000 }, log: () => {} });
  t.after(() => engine.stop());
  await engine.start();
  let h = engine.health();
  assert.equal(h.started, true);
  assert.equal(h.db.version, 13);   // the framework's 1, data layer 2 to 7, ledger 8, backtest 9, learning layer 10 and 11, cost sampler 12 (the worker registers them all; the paper opener adds no table)
  assert.equal(h.stocks.provider, 'mock');
  assert.ok(fs.existsSync(path.join(dataDir, 'stockman.db')), 'the worker owns the database file');

  const missing = await engine.request('quote', { symbol: 'AAA' }).catch(e => e);   // the mock provider has no data: NOT_FOUND crosses the process boundary
  assert.equal(missing.code, 'NOT_FOUND');
  assert.equal((await engine.request('quote', { symbol: 'bad symbol' }).catch(e => e)).code, 'INVALID_REQUEST');
  assert.equal((await engine.request('nope').catch(e => e)).code, 'INVALID_REQUEST');
  assert.equal((await engine.request('health')).db.version, 13);
  assert.deepEqual((await engine.request('health')).features, ['universe', 'bars', 'calendar', 'earnings', 'spreads', 'runs', 'scoring', 'shadow', 'calibration', 'ledger', 'backtest', 'paper', 'whatif', 'options', 'recover', 'broker-router', 'sandbox', 'outbox']);
  assert.ok(Array.isArray(await engine.request('events', { limit: 5 })));
  const dash = await engine.request('dashboard');                                      // the dashboard page's numbers, built in the worker
  assert.equal(dash.engine.started, true); assert.equal(dash.engine.dbVersion, 13); assert.ok(Array.isArray(dash.forward) && dash.forward.length === 7);
  assert.match(dash.note, /never predictions/);
  assert.ok(events.includes('ready'));                                                // the framework's own link event arrived on jarvis's bus

  const pid = engine.health().process.pid;
  process.kill(pid);                                                                  // simulate a crash
  await until(() => events.includes('engine-up'), 15000);
  h = engine.health();
  assert.notEqual(h.process.pid, pid);
  assert.equal(h.process.restarts, 1);
  assert.equal(h.started, true);

  const pid2 = h.process.pid;
  await engine.stop();
  await tick(100);
  assert.throws(() => process.kill(pid2, 0), 'the worker is gone after stop()');
});

test('stockman-process: after giving up it tries again on its own (reviveMs), so a temporary cause does not leave the engine off; stop cancels it', async () => {
  let n = 0;
  const { engine, children, events, lines } = make(c => { n++; if (n <= 3) c.autoReady = false; else c.autoReady = true; if (n <= 3) { const o = c.send; c.send = m => { o(m); if (m.type === 'init') setImmediate(() => c.emit('exit', 1, null)); }; } },
    { restart: { baseMs: 5, maxMs: 10, maxRestarts: 1, resetAfterMs: 60000, reviveMs: 40 } });
  await engine.start().catch(() => {});
  await until(() => engine.health().process.state === 'failed');
  await until(() => engine.health().process.state === 'running', 3000);
  assert.ok(lines.some(l => /trying to start it again/.test(l)) && lines.some(l => /engine is back/.test(l)));
  assert.ok(events.includes('engine-failed') && events.includes('engine-up'));
  await engine.stop();
  assert.equal(engine.health().process.state, 'stopped');
  const off = make(c => { const o = c.send; c.send = m => { o(m); if (m.type === 'init') setImmediate(() => c.emit('exit', 1, null)); }; }, { restart: { baseMs: 5, maxMs: 10, maxRestarts: 1, resetAfterMs: 60000, reviveMs: 0 } });
  await off.engine.start().catch(() => {});
  await tick(120);
  assert.equal(off.children.length, 1, 'reviveMs 0: it stays down, as before');
  await off.engine.stop();
});
