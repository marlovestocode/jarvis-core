// Feature "ledger" (vault Phase 1 ledger part, G11, D20): the paper ledger. ONE record of every paper position, and the only record later
// code (calibration, the cortex write, scorecards) learns from. No real orders exist anywhere in this file or this folder (vault D1, D14, D23).
//
// A position has: who made it (`source`), the scoring build, the run, the basket and sleeve, entry and exit days, the EXPECTED prices
// (what the rule assumed when it decided), the FILL prices (what the paper trade or a later broker paper account got), the cost applied,
// and the result. Slippage is the gap between expected and fill, so it can be measured later instead of assumed.
//   source = backtest         simulated on past data by the backtest tool (a simulation, not a prediction)
//          = paper-internal   jarvis's own paper trade, filled by StockMan's own rule at its stated prices plus the cost model
//          = broker-paper     a fill reported by a broker's PAPER account (Alpaca, decision D23: approved, NOT built). Fake money only.
// Prices in the ledger are MARKET prices as the fill happened. `cost_bps` is the cost the ledger applies on top (round trip, costs.js):
// a backtest or an internal paper trade uses the cost model; a broker paper fill already contains real slippage, so its caller passes the
// commission only (usually 0). Reports recompute net results at 5, 10 and 25 bps from `gross_return`, so a stored net is never the only number.
//
// Fills come in through ONE port (attachFillSource): a source object with `subscribe(handler)`. It can only deliver fills for positions that
// already exist; it has no way to send an order, and attachFillSource refuses an object that has an order-placing method.
const { StockmanError } = require('../errors');
const { BASE_BPS } = require('./costs');

const MIGRATION_VERSION = 8;
const SOURCES = Object.freeze(['backtest', 'paper-internal', 'broker-paper']);
const LEGS = Object.freeze(['entry', 'exit']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ORDER_METHODS = ['placeOrder', 'submitOrder', 'createOrder', 'sendOrder', 'order', 'buy', 'sell'];

const migration = {
  version: MIGRATION_VERSION, name: 'ledger',
  up(raw) {
    raw.exec(`
      CREATE TABLE paper_position(
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('backtest','paper-internal','broker-paper')),
        run_id TEXT,                         -- the daily run (run-YYYY-MM-DD) or the backtest run id (bt-...)
        basket_id TEXT,                      -- the basket this name belongs to (one per signal day)
        sleeve INTEGER,                      -- 0 to 4 for the five overlapping sleeves, null when not sleeved
        scoring_build TEXT NOT NULL,         -- the versioned scoring code and its settings, e.g. rev-v1.0/L5/vol
        symbol TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'long' CHECK(side = 'long'),
        weight REAL,                         -- share of the basket (equal weight: 1/N)
        quantity REAL,                       -- shares, when sized
        score REAL,                          -- the rule's score at the signal
        signal_day TEXT,
        entry_day TEXT NOT NULL, exit_day TEXT NOT NULL,   -- planned until closed, then the actual days
        expected_entry_price REAL, expected_exit_price REAL,
        fill_entry_price REAL, fill_exit_price REAL,
        gross_return REAL,                   -- fill exit / fill entry - 1 (before cost)
        cost_bps REAL,                       -- round-trip cost applied to get net_return
        net_return REAL,
        benchmark_return REAL,               -- SPY over the same entry and exit
        status TEXT NOT NULL CHECK(status IN ('open','closed','cancelled')),
        opened_at INTEGER NOT NULL, closed_at INTEGER,
        note TEXT);
      CREATE INDEX paper_position_run ON paper_position(run_id);
      CREATE INDEX paper_position_symbol ON paper_position(symbol, entry_day);
      CREATE INDEX paper_position_status ON paper_position(source, status);
      -- every fill that reached a position, from any source. A broker paper account writes here too.
      CREATE TABLE paper_fill(
        id INTEGER PRIMARY KEY,
        position_id INTEGER NOT NULL REFERENCES paper_position(id),
        leg TEXT NOT NULL CHECK(leg IN ('entry','exit')),
        source TEXT NOT NULL CHECK(source IN ('backtest','paper-internal','broker-paper')),
        price REAL NOT NULL, quantity REAL, day TEXT NOT NULL,
        external_id TEXT,                    -- the broker's fill id, so a repeated delivery is stored once
        at INTEGER NOT NULL);
      CREATE INDEX paper_fill_position ON paper_fill(position_id);
      CREATE UNIQUE INDEX paper_fill_external ON paper_fill(source, external_id) WHERE external_id IS NOT NULL;
    `);
  },
};

const isDay = d => typeof d === 'string' && DAY.test(d);
const num = (v, name, { positive = false, optional = true } = {}) => {
  if (v === undefined || v === null) { if (optional) return null; throw new StockmanError(`ledger: ${name} is required`); }
  if (typeof v !== 'number' || !Number.isFinite(v) || (positive && v <= 0)) throw new StockmanError(`ledger: ${name} must be a ${positive ? 'positive ' : ''}number (got ${v})`);
  return v;
};

function createLedger({ now = Date.now } = {}) {
  let db = null;
  const need = () => { if (!db) throw new StockmanError('ledger: not started'); return db; };
  const unsubscribers = [];

  function check(p) {
    if (!p || typeof p !== 'object') throw new StockmanError('ledger: a position is an object');
    if (!SOURCES.includes(p.source)) throw new StockmanError(`ledger: source must be one of ${SOURCES.join(', ')} (got ${p.source})`);
    if (typeof p.symbol !== 'string' || !p.symbol) throw new StockmanError('ledger: symbol is required');
    if (typeof p.scoringBuild !== 'string' || !p.scoringBuild) throw new StockmanError('ledger: scoringBuild is required (every result names the code that made it)');
    if (!isDay(p.entryDay) || !isDay(p.exitDay)) throw new StockmanError('ledger: entryDay and exitDay are YYYY-MM-DD');
    if (p.exitDay <= p.entryDay) throw new StockmanError('ledger: exitDay must be after entryDay');
    if (p.sleeve !== undefined && p.sleeve !== null && !(Number.isInteger(p.sleeve) && p.sleeve >= 0 && p.sleeve < 5)) throw new StockmanError('ledger: sleeve is 0 to 4');
  }
  const cols = p => [
    p.source, p.runId ?? null, p.basketId ?? null, p.sleeve ?? null, p.scoringBuild, p.symbol,
    num(p.weight, 'weight'), num(p.quantity, 'quantity'), num(p.score, 'score'), p.signalDay ?? null, p.entryDay, p.exitDay,
    num(p.expectedEntryPrice, 'expectedEntryPrice', { positive: true }), num(p.expectedExitPrice, 'expectedExitPrice', { positive: true }),
    num(p.fillEntryPrice, 'fillEntryPrice', { positive: true }), num(p.fillExitPrice, 'fillExitPrice', { positive: true }),
    num(p.grossReturn, 'grossReturn'), num(p.costBps, 'costBps'), num(p.netReturn, 'netReturn'), num(p.benchmarkReturn, 'benchmarkReturn'),
    p.status, now(), p.status === 'closed' ? now() : null, p.note ?? null,
  ];
  const INSERT = `INSERT INTO paper_position(source, run_id, basket_id, sleeve, scoring_build, symbol, weight, quantity, score, signal_day, entry_day, exit_day,
    expected_entry_price, expected_exit_price, fill_entry_price, fill_exit_price, gross_return, cost_bps, net_return, benchmark_return, status, opened_at, closed_at, note)
    VALUES (${new Array(24).fill('?').join(',')})`;

  // open a position (status open). Returns its id.
  function open(p) {
    check(p);
    return Number(need().stmt(INSERT).run(...cols({ ...p, status: 'open' })).lastInsertRowid);
  }

  // store a finished position in one go (the backtest): the gross result and the cost are computed by the caller from prices
  function insertClosed(p) {
    check(p);
    num(p.grossReturn, 'grossReturn', { optional: false }); num(p.netReturn, 'netReturn', { optional: false });
    return Number(need().stmt(INSERT).run(...cols({ ...p, status: 'closed' })).lastInsertRowid);
  }
  // many at once in one transaction (a backtest writes thousands)
  function insertClosedBatch(list) {
    const d = need();
    return d.tx(() => list.map(p => insertClosed(p)).length);
  }

  const getPosition = id => need().stmt('SELECT * FROM paper_position WHERE id = ?').get(id) || null;

  // a fill reached a position. Source must match the position's: a broker paper fill cannot land on a backtest row, and the reverse.
  // The position's fill price for that leg becomes the quantity-weighted average of its fills. Repeated delivery (same source and
  // externalId) is stored once and returns the first fill's id.
  function recordFill({ positionId, leg, price, day, quantity = null, source, externalId = null }) {
    const d = need();
    if (!LEGS.includes(leg)) throw new StockmanError('ledger: leg is entry or exit');
    if (!SOURCES.includes(source)) throw new StockmanError(`ledger: fill source must be one of ${SOURCES.join(', ')}`);
    if (!isDay(day)) throw new StockmanError('ledger: fill day is YYYY-MM-DD');
    num(price, 'price', { positive: true, optional: false }); num(quantity, 'quantity', { positive: true });
    const pos = getPosition(positionId);
    if (!pos) throw new StockmanError(`ledger: no position ${positionId}`);
    if (pos.source !== source) throw new StockmanError(`ledger: a ${source} fill cannot go to a ${pos.source} position`);
    if (pos.status !== 'open') throw new StockmanError(`ledger: position ${positionId} is ${pos.status}, fills go to open positions only`);
    if (externalId !== null) {
      const dup = d.stmt('SELECT id FROM paper_fill WHERE source = ? AND external_id = ?').get(source, String(externalId));
      if (dup) return { id: Number(dup.id), duplicate: true };
    }
    return d.tx(() => {
      const id = Number(d.stmt('INSERT INTO paper_fill(position_id, leg, source, price, quantity, day, external_id, at) VALUES (?,?,?,?,?,?,?,?)')
        .run(positionId, leg, source, price, quantity, day, externalId === null ? null : String(externalId), now()).lastInsertRowid);
      const fills = d.stmt('SELECT price, quantity FROM paper_fill WHERE position_id = ? AND leg = ?').all(positionId, leg);
      const totalQ = fills.reduce((s, f) => s + (f.quantity ?? 1), 0);
      const avg = fills.reduce((s, f) => s + f.price * (f.quantity ?? 1), 0) / totalQ;
      d.stmt(`UPDATE paper_position SET ${leg === 'entry' ? 'fill_entry_price' : 'fill_exit_price'} = ?, ${leg === 'entry' ? 'entry_day' : 'exit_day'} = ? WHERE id = ?`).run(avg, day, positionId);
      return { id, duplicate: false };
    });
  }

  // close an open position from its two fills (both must exist). costBps is the cost applied on top (default: the model's base case).
  function close(id, { costBps = BASE_BPS, benchmarkReturn = null } = {}) {
    const d = need();
    const pos = getPosition(id);
    if (!pos) throw new StockmanError(`ledger: no position ${id}`);
    if (pos.status !== 'open') throw new StockmanError(`ledger: position ${id} is already ${pos.status}`);
    if (!(pos.fill_entry_price > 0) || !(pos.fill_exit_price > 0)) throw new StockmanError(`ledger: position ${id} needs an entry fill and an exit fill before it can close`);
    const gross = pos.fill_exit_price / pos.fill_entry_price - 1;
    const net = gross - num(costBps, 'costBps', { optional: false }) / 10000;
    d.stmt("UPDATE paper_position SET status = 'closed', gross_return = ?, cost_bps = ?, net_return = ?, benchmark_return = ?, closed_at = ? WHERE id = ?").run(gross, costBps, net, benchmarkReturn, now(), id);
    return { id, grossReturn: gross, netReturn: net };
  }
  function cancel(id, reason) {
    const pos = getPosition(id);
    if (!pos || pos.status !== 'open') throw new StockmanError(`ledger: position ${id} is not open`);
    need().stmt("UPDATE paper_position SET status = 'cancelled', note = ?, closed_at = ? WHERE id = ?").run(reason ?? null, now(), id);
  }

  // change the note of a position that is still open (the paper opener records a gap here; a closed row is never edited)
  function annotate(id, note) {
    const r = need().stmt("UPDATE paper_position SET note = ? WHERE id = ? AND status = 'open'").run(note ?? null, id);
    return Number(r.changes) === 1;
  }

  function list({ source, runId, status, symbol, limit = 100 } = {}) {
    const where = [], args = [];
    if (source) { where.push('source = ?'); args.push(source); }
    if (runId) { where.push('run_id = ?'); args.push(runId); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (symbol) { where.push('symbol = ?'); args.push(symbol); }
    return need().stmt(`SELECT * FROM paper_position ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY entry_day, id LIMIT ?`).all(...args, Math.max(1, Math.min(100000, limit)));
  }
  function count(filter = {}) {
    const where = [], args = [];
    for (const [k, c] of [['source', 'source'], ['runId', 'run_id'], ['status', 'status']]) if (filter[k]) { where.push(`${c} = ?`); args.push(filter[k]); }
    return Number(need().stmt(`SELECT COUNT(*) AS n FROM paper_position ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).n);
  }
  // simulated rows can be regenerated, so a backtest re-run replaces its own earlier rows. Nothing else can be deleted through this.
  function deleteBacktestRuns(runIds) {
    const d = need();
    return d.tx(() => { let n = 0; for (const id of runIds) n += Number(d.stmt("DELETE FROM paper_position WHERE source = 'backtest' AND run_id = ?").run(id).changes); return n; });
  }

  // The fills port. `port` = { name, source, subscribe(handler) → unsubscribe }. The handler takes
  //   { positionId, leg, price, day, quantity?, externalId? }
  // and writes the fill into the ledger under the port's source. A fill that cannot be stored (unknown position, wrong source) is
  // reported to onError and dropped; it never throws into the port. The port has no way to place an order.
  function attachFillSource(port, { onError = () => {} } = {}) {
    if (!port || typeof port.subscribe !== 'function' || !SOURCES.includes(port.source) || port.source === 'backtest') throw new StockmanError('ledger: a fill source needs subscribe() and a source of paper-internal or broker-paper');
    for (const m of ORDER_METHODS) if (typeof port[m] === 'function') throw new StockmanError(`ledger: a fill source must not be able to place orders (found ${m}()); no real orders, ever (vault D1)`);
    const off = port.subscribe(fill => {
      try { recordFill({ ...fill, source: port.source }); } catch (err) { try { onError(err, fill); } catch { /* the port must not break */ } }
    });
    const stop = typeof off === 'function' ? off : () => {};
    unsubscribers.push(stop);
    return stop;
  }

  const api = { open, insertClosed, insertClosedBatch, recordFill, close, cancel, annotate, getPosition, list, count, deleteBacktestRuns, attachFillSource, SOURCES };
  const feature = {
    id: 'ledger', migrations: [migration],
    async start(ctx) { db = ctx.db; },
    async stop() { while (unsubscribers.length) { try { unsubscribers.pop()(); } catch { /* best effort */ } } db = null; },
  };
  return { feature, api };
}

// a test double and a template for a real source: deliver() pushes a fill to whoever subscribed
function createMemoryFillPort({ source = 'broker-paper', name = 'memory' } = {}) {
  const handlers = new Set();
  return {
    name, source,
    subscribe(h) { handlers.add(h); return () => handlers.delete(h); },
    deliver(fill) { for (const h of [...handlers]) h(fill); },
  };
}

module.exports = { createLedger, createMemoryFillPort, MIGRATION_VERSION, SOURCES };
