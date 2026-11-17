// The paper-trade opener (trading/paper.js, vault Phase 1 exit test, CL-0049): a position is opened from a shadow basket, entered at the next open,
// marked open until the exit bar exists, then closed with costs; it survives a restart on the same file; gaps are recorded, never filled; the
// engine writes while a conversational turn is tainted (D11). OFF by default. Paper only: no order, no network, no broker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { createLearningLayer } = require('../src/core/stockman/learning');
const { createTradingLayer } = require('../src/core/stockman/trading');
const { loadConfig } = require('../src/core/stockman/config');
const { clock, putBars, walk, tradingDays, one, count } = require('./helpers/stockman-learning');

const DAYS = tradingDays('2026-07-01', '2026-12-10');
const D = '2026-11-16', ENTRY = '2026-11-17', EXIT = '2026-11-23';
const MEMBERS = Array.from({ length: 24 }, (_, i) => `M${String(i).padStart(2, '0')}`);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-paper-')), 'stockman.db');
const PRICE = new Map([...MEMBERS, 'SPY'].map(s => [s, walk(s, s === 'SPY' ? 400 : 60 + (s.charCodeAt(2) % 7) * 10, 0.012)]));

// the app with the data stand-ins of the learning tests, the learning layer and the trading layer (the paper opener on or off)
async function make({ dbFile = ':memory:', enabled = true, nowIso = '2026-11-16T22:00:00Z', members = MEMBERS } = {}) {
  const now = clock(nowIso);
  const prov = createMockProvider({ bars: {}, ranges: ['1mo'], intervals: ['1d'], now });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile, log: () => {}, provider: prov, now, sleep: async () => {} });
  const bars = createBars({ now, sleep: async () => {} });
  const data = {
    bars: bars.api,
    universe: { membersAsOf: () => ({ sp500: { snapshotAsOf: '2026-10-01', kind: 'history', symbols: [...members] }, ndx100: null }) },
    runs: { getRun: day => ({ run_id: `run-${day}`, trade_day: day, state: 'ingested' }) },
    earnings: { flags: () => ({ earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed' }) },
  };
  const learning = createLearningLayer({ data, now, autoRun: false });
  const trading = createTradingLayer({ data: { ...data, ...learning.api }, now, options: enabled === 'default' ? {} : { paper: { enabled, autoRun: false } } });
  app.use(bars.feature);
  for (const f of [...learning.features, ...trading.features]) app.use(f);
  await app.start();
  const load = upTo => { for (const s of [...MEMBERS, 'SPY']) putBars(app, s, DAYS.filter(d => d <= upTo), { price: PRICE.get(s) }); };
  return { app, now, shadow: learning.api.shadow, ledger: trading.api.ledger, paper: trading.api.paper, load };
}
const positions = X => X.ledger.list({ source: 'paper-internal', limit: 1000 });

test('paper: OFF by default: the step does nothing, nothing is opened, and the status line says OFF', async () => {
  const X = await make({ enabled: 'default' });
  X.load(D);
  assert.equal(X.shadow.logDay(D).status, 'logged');
  assert.equal(X.paper.options.enabled, false);
  assert.deepEqual(await X.paper.step(), { status: 'off' });
  assert.equal(positions(X).length, 0);
  assert.match(X.app.health().dataQuality.paper.summary, /^paper trading: OFF/);
  await X.app.stop();
});

test('paper: config: off unless STOCKMAN_PAPER_TRADING or paperTrading.enabled says on', () => {
  assert.equal(loadConfig({ env: {}, dataDir: os.tmpdir(), readFile: () => { const e = new Error('none'); e.code = 'ENOENT'; throw e; } }).paperTrading.enabled, false);
  assert.equal(loadConfig({ env: { STOCKMAN_PAPER_TRADING: 'on' }, dataDir: os.tmpdir(), readFile: () => { const e = new Error('none'); e.code = 'ENOENT'; throw e; } }).paperTrading.enabled, true);
  assert.throws(() => loadConfig({ env: { STOCKMAN_PAPER_TRADING: 'maybe' }, dataDir: os.tmpdir() }), /true or false/);
});

test('paper: opens the basket, enters at the next open, marks it open, then closes with costs and the benchmark', async () => {
  const X = await make();
  X.load(D);
  const day = X.shadow.logDay(D);
  assert.equal(day.late, false);
  // 1. signal logged, entry bar not there yet: 20 positions open, none entered
  let r = await X.paper.step();
  assert.equal(r.opened, 20); assert.equal(r.entered, 0); assert.equal(r.closed, 0);
  let ps = positions(X);
  assert.equal(ps.length, 20);
  assert.ok(ps.every(p => p.status === 'open' && p.source === 'paper-internal' && p.fill_entry_price === null));
  const basket = X.app.db.stmt("SELECT candidate_id, symbol, run_id FROM candidate WHERE in_basket = 1 AND day = ?").all(D);
  assert.deepEqual(ps.map(p => p.symbol).sort(), basket.map(b => b.symbol).sort(), 'exactly the shadow basket');
  for (const p of ps) {
    const c = basket.find(b => b.symbol === p.symbol);
    assert.equal(p.run_id, c.run_id); assert.equal(p.run_id, `run-${D}`);
    assert.equal(X.paper.candidateOf(p), c.candidate_id, 'linked to the candidate row by id');
    assert.equal(p.scoring_build, `${X.shadow.status().build}/L5/vol`);
    assert.equal(p.entry_day, ENTRY); assert.equal(p.exit_day, EXIT); assert.equal(p.weight, 1 / 20);
    assert.ok(p.sleeve >= 0 && p.sleeve < 5); assert.ok(p.expected_entry_price > 0);
  }
  assert.equal(X.paper.sleeveOf('2026-11-13'), 0); assert.equal(X.paper.sleeveOf('2026-11-20'), 0);   // a week apart: same sleeve; the grid ends on 2026-11-13
  assert.equal(X.paper.sleeveOf('2026-11-16'), 4);
  // 2. the entry session has bars: entered at the adjusted open, still open
  X.load(ENTRY);
  r = await X.paper.step();
  assert.equal(r.opened, 0); assert.equal(r.entered, 20); assert.equal(r.closed, 0);
  for (const p of positions(X)) {
    const b = one(X.app, 'SELECT open, close, adj_close AS adj FROM bar WHERE symbol = ? AND day = ?', p.symbol, ENTRY);
    assert.equal(p.status, 'open');
    assert.ok(Math.abs(p.fill_entry_price - b.open * (b.adj / b.close)) < 1e-9);
  }
  assert.equal(count(X.app, "SELECT COUNT(*) AS n FROM paper_fill WHERE source = 'paper-internal' AND leg = 'entry'"), 20);
  // 3. the exit session has bars: closed with the cost model's 10 bps and SPY's return
  X.load(EXIT);
  r = await X.paper.step();
  assert.equal(r.closed, 20);
  const spyE = one(X.app, 'SELECT open, close, adj_close AS adj FROM bar WHERE symbol = ? AND day = ?', 'SPY', ENTRY);
  const spyX = one(X.app, 'SELECT adj_close AS adj FROM bar WHERE symbol = ? AND day = ?', 'SPY', EXIT);
  const bench = spyX.adj / (spyE.open * (spyE.adj / spyE.close)) - 1;
  for (const p of positions(X)) {
    const x = one(X.app, 'SELECT adj_close AS adj FROM bar WHERE symbol = ? AND day = ?', p.symbol, EXIT);
    assert.equal(p.status, 'closed');
    assert.ok(Math.abs(p.fill_exit_price - x.adj) < 1e-9);
    assert.ok(Math.abs(p.gross_return - (x.adj / p.fill_entry_price - 1)) < 1e-12);
    assert.equal(p.cost_bps, 10);
    assert.ok(Math.abs(p.net_return - (p.gross_return - 0.001)) < 1e-12, 'net = gross minus 10 bps round trip');
    assert.ok(Math.abs(p.benchmark_return - bench) < 1e-12);
  }
  // 4. a rerun is a no-op
  r = await X.paper.step();
  assert.deepEqual([r.opened, r.entered, r.closed, r.gaps], [0, 0, 0, 0]);
  assert.equal(positions(X).length, 20);
  assert.equal(count(X.app, "SELECT COUNT(*) AS n FROM paper_fill WHERE source = 'paper-internal'"), 40);
  assert.match(X.paper.health().summary, /20 closed.*10 bps/);
  await X.app.stop();
});

test('paper: survives a restart on the same database file: open positions are entered and closed by the new process, with no duplicates', async () => {
  const file = tmpFile();
  let X = await make({ dbFile: file });
  X.load(D); X.shadow.logDay(D);
  await X.paper.step(); X.load(ENTRY); await X.paper.step();
  assert.equal(positions(X).filter(p => p.status === 'open' && p.fill_entry_price > 0).length, 20);
  await X.app.stop();                                                   // the app is closed for a while...
  X = await make({ dbFile: file, nowIso: '2026-11-25T14:00:00Z' });     // ...and a new process opens the same file
  assert.equal(positions(X).length, 20, 'the open positions are still there');
  X.load(EXIT);                                                         // the bars arrived while it was closed (the data layer's catch-up)
  const r = await X.paper.step();
  assert.deepEqual([r.opened, r.entered, r.closed], [0, 0, 20]);
  assert.equal(positions(X).length, 20); assert.ok(positions(X).every(p => p.status === 'closed'));
  const again = await X.paper.step();
  assert.deepEqual([again.opened, again.entered, again.closed], [0, 0, 0]);
  assert.equal(count(X.app, "SELECT COUNT(*) AS n FROM paper_position WHERE source = 'paper-internal'"), 20);
  await X.app.stop();
});

test('paper: a missing bar is a recorded gap, never filled; a late bar fixes it', async () => {
  const X = await make();
  X.load(D); X.shadow.logDay(D);
  await X.paper.step();
  const victim = positions(X)[0].symbol;
  const keep = X.app.db.stmt('SELECT * FROM bar WHERE symbol = ? AND day = ?');
  // every bar through the exit day and 4 sessions past it, except the victim's entry-day bar
  X.load('2026-11-30');
  const lost = keep.get(victim, ENTRY);
  X.app.db.stmt('DELETE FROM bar WHERE symbol = ? AND day = ?').run(victim, ENTRY);
  const r = await X.paper.step();
  assert.equal(r.gaps, 1);
  assert.equal(r.closed, 19);
  const p = positions(X).find(x => x.symbol === victim);
  assert.equal(p.status, 'open'); assert.equal(p.fill_entry_price, null); assert.equal(p.fill_exit_price, null);
  assert.match(p.note, /gap: no_entry_bar/); assert.match(p.note, /^candidate=/);
  assert.equal(X.paper.status().gaps, 1);
  assert.match(X.paper.health().summary, /1 gap/);
  // the missing bar arrives late: the position is entered and closed, the gap note goes away, the other 19 are untouched
  X.app.db.stmt('INSERT INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(lost.symbol, lost.day, lost.open, lost.high, lost.low, lost.close, lost.adj_close, lost.volume, 'late', 1);
  const r2 = await X.paper.step();
  assert.equal(r2.entered, 1); assert.equal(r2.closed, 1);
  const q = positions(X).find(x => x.symbol === victim);
  assert.equal(q.status, 'closed'); assert.doesNotMatch(q.note, /gap:/);
  await X.app.stop();
});

test('paper: holdout days, late days and days with no logged candidates are never traded', async () => {
  const X = await make();
  // a candidate row inside the holdout (on or before 2026-11-13) is skipped whatever its flags
  X.load(D);
  X.shadow.logDay(D);
  X.app.db.stmt("UPDATE candidate SET day = '2026-11-13', run_id = 'run-2026-11-13', candidate_id = 'run-2026-11-13/' || symbol || '/' || scoring_build, entry_day = '2026-11-16', exit_day = '2026-11-20' WHERE day = ?").run(D);
  X.app.db.stmt("UPDATE shadow_day SET day = '2026-11-13', run_id = 'run-2026-11-13'").run();
  assert.equal(await X.paper.step().then(r => r.opened), 0, 'holdout day: nothing opened');
  // a day logged after its entry session is `late` and is not traded
  const Y = await make({ nowIso: '2026-11-19T22:00:00Z' });
  Y.load(D);
  assert.equal(Y.shadow.logDay(D).late, true);
  assert.equal(await Y.paper.step().then(r => r.opened), 0, 'late day: nothing opened');
  assert.equal(Y.paper.status().lateDaysSkipped, 1);
  await X.app.stop(); await Y.app.stop();
});

test('paper: the engine writes while a conversational turn is tainted (D11): the turn cannot write trust, the engine still can', async () => {
  const cortex = require('../src/core/cortex').open({});
  const user = cortex.source.add({ kind: 'user', ref: 'chat' });
  // a tainted turn (it read outside text) is refused a user-trust write...
  assert.throws(() => cortex.node.upsert({ kind: 'fact', key: 'k1', text: 'a fact from a tainted turn', source: user, tainted: true }), /cannot write user trust/);
  // ...and meanwhile the engine, which has no turn, writes its ledger on its own schedule
  const X = await make();
  X.load(D); X.shadow.logDay(D);
  const turn = { tainted: true };
  assert.equal(turn.tainted, true);
  const a = await X.paper.step(); X.load(ENTRY); const b = await X.paper.step(); X.load(EXIT); const c = await X.paper.step();
  assert.deepEqual([a.opened, b.entered, c.closed], [20, 20, 20]);
  assert.equal(positions(X).filter(p => p.status === 'closed').length, 20);
  // the engine does not depend on the conversational path at all
  const src = fs.readFileSync(require.resolve('../src/core/stockman/trading/paper.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['cortex', 'orchestrator', 'brain', 'skills', 'tools/registry', 'fetcher', 'placeOrder', 'submitOrder', 'broker']) assert.ok(!src.includes(bad), `paper.js must not mention ${bad}`);
  assert.ok(!/require\(['"]node:(http|https|net)/.test(src));
  await X.app.stop();
});
