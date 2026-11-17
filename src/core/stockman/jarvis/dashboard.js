// The numbers behind the StockMan dashboard page (src/ui/stockman, served by core/bridge.js at /ai/stockman). Built inside the engine process
// (worker op `dashboard`), which owns stockman.db; jarvis never opens the file. Read-only: it only SELECTs and calls the features' own read methods.
// Everything here is a measurement of past data or of the live feed, never a prediction; the page says so.
//   buildState({ app, api, config, now }) → one JSON-able object. A part that fails is reported as { error } and the rest still render.
const { nyDate } = require('../features/ny-time');
const { marketOpenNow } = require('../features/calendar-rules');

const COST_BPS = 10;   // the cost model's base case (trading/costs.js), shown beside gross figures
const FORWARD_DAYS = 400;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function part(fn) { try { return fn(); } catch (err) { return { error: String(err?.message || err).slice(0, 200) }; } }

// forward (live shadow) results per variant: for each logged day, the variant's top-20 basket's mean excess over SPY of the filled outcomes
// (gross of costs), then the mean over days. Baskets start every session, so days overlap: the figure is a mean, not an independent test.
function forwardResults(db, scoring) {
  const out = [];
  const dayStat = (byDay) => {
    const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-FORWARD_DAYS).map(([day, v]) => ({ day, n: v.length, excess: mean(v) }));
    const ex = days.map(d => d.excess);
    return {
      days: days.length, meanGross: mean(ex), meanNet10: ex.length ? mean(ex) - COST_BPS / 1e4 : null,
      winShare: ex.length ? ex.filter(x => x - COST_BPS / 1e4 > 0).length / ex.length : null, names: days.reduce((s, d) => s + d.n, 0),
      series: days.slice(-60).map(d => [d.day, d.excess]),
    };
  };
  // reversal: the primary variant's basket is the in_basket flag. Rows exist for every logged day with filled outcomes.
  for (const [rule, R] of Object.entries(scoring.rules)) {
    const build = R.build;
    const all = db.stmt(`SELECT c.day AS day, c.in_basket AS inBasket, c.variants AS variants, o.excess AS excess
      FROM candidate c JOIN candidate_outcome o ON o.candidate_id = c.candidate_id WHERE c.scoring_build = ? AND o.status = 'ok'`).all(build);
    if (rule === 'reversal') {
      const byDay = new Map();
      for (const r of all) if (r.inBasket === 1) { const a = byDay.get(r.day) || []; a.push(r.excess); byDay.set(r.day, a); }
      out.push({ id: 'rev5s', rule, build, label: 'reversal L5 vol (primary)', ...dayStat(byDay) });
    } else {
      for (const v of R.variants) {
        const byDay = new Map();
        for (const r of all) {
          let x; try { x = JSON.parse(r.variants)?.[v.id]; } catch { x = null; }
          if (x && x.inBasket) { const a = byDay.get(r.day) || []; a.push(r.excess); byDay.set(r.day, a); }
        }
        out.push({ id: v.id, rule, build, label: `momentum L${v.lookback} ${v.scaled ? 'vol' : 'raw'}`, ...dayStat(byDay) });
      }
    }
  }
  return out;
}

function backtests(db) {
  const rows = db.stmt("SELECT variant_key AS variant, period, summary, started_at AS at FROM backtest_run WHERE status = 'done' ORDER BY started_at DESC").all();
  const seen = new Set(), out = [];
  for (const r of rows) {
    const k = `${r.variant}|${r.period}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let s; try { s = JSON.parse(r.summary); } catch { continue; }
    const l = s?.summary?.levels?.[10];
    out.push({ variant: r.variant, period: r.period, windows: s?.summary?.windows ?? null, grossExcess: s?.summary?.grossExcessMean ?? null, net10: l?.meanExcess ?? null, lo: l?.lower95 ?? null, hi: l?.upper95 ?? null, pass: Boolean(l?.lowerBoundAboveZero), at: r.at });
  }
  return out.sort((a, b) => (a.variant < b.variant ? -1 : 1));
}

function spreadPanel(db, spreads, day) {
  const s = spreads.summary({ from: day, to: day });
  const buckets = db.stmt(`SELECT (sampled_at / 900000) AS b, COUNT(*) AS n, AVG(spread_bps) AS avg, MIN(sampled_at) AS t FROM spread_sample
    WHERE status = 'ok' AND day = ? GROUP BY b ORDER BY b`).all(day).map(r => ({ t: Number(r.t), n: Number(r.n), avg: r.avg }));
  const latest = db.stmt(`SELECT symbol, spread_bps AS bps, bid, ask, bid_size AS bidSize, ask_size AS askSize, exchange, sampled_at AS at FROM spread_sample
    WHERE status = 'ok' ORDER BY id DESC LIMIT 40`).all();
  const widest = db.stmt(`SELECT symbol, AVG(spread_bps) AS bps, COUNT(*) AS n FROM spread_sample WHERE status = 'ok' AND day = ? GROUP BY symbol ORDER BY bps DESC LIMIT 8`).all(day);
  const tightest = db.stmt(`SELECT symbol, AVG(spread_bps) AS bps, COUNT(*) AS n FROM spread_sample WHERE status = 'ok' AND day = ? GROUP BY symbol ORDER BY bps ASC LIMIT 8`).all(day);
  return { day, summary: s, buckets, latest, widest, tightest, assumedBps: COST_BPS };
}

function buildState({ app, api, config = {}, now = Date.now }) {
  const t = now(), day = nyDate(t), db = app.db;
  const health = part(() => app.health());
  return {
    asOf: t, nyDay: day, marketOpen: part(() => marketOpenNow(t)),
    engine: part(() => ({ started: health.started, provider: health.stocks?.provider, breaker: health.stocks?.breaker, calls: health.stocks?.calls, failures: health.stocks?.failures, lastOkAt: health.stocks?.lastOkAt, lastError: health.stocks?.lastError, dbVersion: health.db?.version, features: health.features })),
    summaries: part(() => Object.fromEntries(Object.entries(health.dataQuality || {}).map(([k, v]) => [k, v?.summary || '']))),
    data: part(() => { const h = api.runs.health(); return { summary: h.summary, ...Object.fromEntries(['targetSession', 'coverage', 'dataAgeMs', 'lastSweepAgeMs', 'gaps', 'lastRun', 'deepHistory', 'pointInTimeHistory', 'earnings'].map(k => [k, h[k]])) }; }),
    spreads: part(() => spreadPanel(db, api.spreads, day)),
    options: part(() => (api.options ? api.options.summary({ from: day, to: day }) : null)),
    router: part(() => (api.router ? api.router.status() : null)),
    shadow: part(() => ({ reversal: api.shadow.status('reversal'), momentum: api.shadow.status('momentum') })),
    forward: part(() => forwardResults(db, api.scoring)),
    calibration: part(() => api.calibration.health()),
    backtests: part(() => backtests(db)),
    ledger: part(() => db.stmt('SELECT source, status, COUNT(*) AS n FROM paper_position GROUP BY source, status').all()),
    switches: { paperTrading: Boolean(config.paperTrading?.enabled), brokerOrders: Boolean(config.broker?.enabled), brokerMaxNotionalUsd: config.broker?.maxNotionalUsd ?? null },
    events: part(() => (app.events ? app.events.recent({ limit: 25, level: 'info' }).map(e => ({ at: e.at, level: e.level, source: e.source, message: String(e.message).slice(0, 240) })) : [])),
    note: 'Simulations of past data and a live feed, never predictions. Paper only.',
  };
}

module.exports = { buildState, forwardResults, backtests, spreadPanel };
