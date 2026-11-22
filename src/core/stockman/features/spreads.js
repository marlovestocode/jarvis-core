// Feature "spreads", the cost sampler (vault G11, note 06 "Cost model"; CL-0060): during US market hours it reads the quoted bid and ask
// of universe symbols and stores them, so the round-trip cost the backtests ASSUME (10 bps, reported at 5 / 10 / 25) can be checked
// against what the market actually quoted. It also stores how old the last trade was when the answer arrived (a freshness check).
//   source:  https://api.nasdaq.com/api/quote/SYMBOL/info?assetclass=stocks, keyless, host already allowed (CL-0007), fetched through
//            jarvis's fetcher under the 'finance' source, so online.finance switches it off. The list spelling works (BRK.B), seen live.
//   shape, seen live 2026-11-17 13:38 ET: { data: { symbol, exchange: 'NASDAQ-GS' | 'NYSE' | ..., isNasdaqListed, marketStatus: 'Open',
//            primaryData: { lastSalePrice: '$350.43', bidPrice: '$350.42', askPrice: '$350.48', bidSize: '62', askSize: '81',
//            isRealTime: true, lastTradeTimestamp: 'Nov 17, 2026 1:37 PM ET' } } }. Outside hours bid and ask are 'N/A'.
//            An unknown symbol answers { data: null, status: { bCodeMessage: [{ code: 1001, errorMessage: 'Symbol not exists.' }] } }.
//   honest limits: the quote is what Nasdaq shows; for a symbol listed elsewhere (NYSE) it may be Nasdaq's own book, not the national best
//            bid and offer, so it can OVERSTATE the true spread (the report splits Nasdaq-listed from others). A quoted spread is not the
//            whole cost: size, market impact and the opening auction (our entries are at the open) are not in it. The last-trade time has
//            minute resolution, so the freshness figure is good to about a minute.
//   plan:    every `everyMin` minutes while the regular session is open, one round of `perRound` symbols, paced `paceMs` apart, the
//            symbols sampled least today first, so over a day every symbol is seen several times at different times of day.
//            Three failures in a row, or a policy refusal, end the round early. Nothing is filled or guessed.
// Writes only its own table. Read-only towards the network. No orders.
const { nyDate, nyWallToMs } = require('./ny-time');
const { dayInfo, marketOpenNow } = require('./calendar-rules');
const { mapHttpError } = require('../stocks/yahoo');
const { PolicyError, StockmanError } = require('../errors');

const MIGRATION_VERSION = 12;
const URL_FOR = symbol => `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`;
const ASSUMED_BPS = 10;   // the cost model's base case (trading/costs.js BASE_BPS), shown beside the measured figure

const migration = {
  version: MIGRATION_VERSION, name: 'spreads',
  up(raw) {
    raw.exec(`
      -- one row per quote asked for. status ok = a bid and an ask were quoted; no_quote = the answer had none (N/A, crossed, unknown symbol);
      -- failed = no usable answer (network, HTTP, shape). spread_bps = (ask - bid) / midpoint * 10000, the cost of one round trip at the quote.
      CREATE TABLE spread_sample(
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL,
        day TEXT NOT NULL,                       -- New York date of the sample
        sampled_at INTEGER NOT NULL,             -- ms, when the answer arrived
        minute_of_session INTEGER,               -- minutes since the open of that session
        status TEXT NOT NULL CHECK(status IN ('ok','no_quote','failed')),
        bid REAL, ask REAL, bid_size INTEGER, ask_size INTEGER, last REAL,
        spread_bps REAL,
        real_time INTEGER,                       -- the provider's isRealTime flag (1, 0, null)
        exchange TEXT, nasdaq_listed INTEGER,
        last_trade_at INTEGER,                   -- ms, the provider's last-trade time (minute resolution)
        note TEXT);
      CREATE INDEX spread_sample_day ON spread_sample(day, symbol);
    `);
  },
};

// ---- parsing (pure) -------------------------------------------------------------------------------------------------------------
function money(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (!s || /^n\/?a$/i.test(s)) return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}
const count = v => { const x = money(v); return x === null ? null : Math.round(x); };
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
// 'Nov 17, 2026 1:37 PM ET' → ms (New York wall time), or null
function parseTradeTime(s) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM) ET$/.exec(String(s || '').trim());
  if (!m || !MONTHS[m[1]]) return null;
  let h = Number(m[4]) % 12;
  if (m[6] === 'PM') h += 12;
  const day = `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return nyWallToMs(day, `${String(h).padStart(2, '0')}:${m[5]}`);
}
// the Nasdaq info answer → { known, bid, ask, bidSize, askSize, last, realTime, exchange, nasdaqListed, lastTradeAt, marketStatus }, or null
// when the shape is not what was seen (a shape change must fail loudly, not become zeros)
function parseQuote(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.data === null) {
    const codes = (json.status?.bCodeMessage || []).map(x => x?.code);
    return codes.includes(1001) ? { known: false } : null;
  }
  const d = json.data, p = d?.primaryData;
  if (!d || !p || typeof p !== 'object') return null;
  return {
    known: true, bid: money(p.bidPrice), ask: money(p.askPrice), bidSize: count(p.bidSize), askSize: count(p.askSize), last: money(p.lastSalePrice),
    realTime: typeof p.isRealTime === 'boolean' ? p.isRealTime : null, exchange: d.exchange ? String(d.exchange).slice(0, 20) : null,
    nasdaqListed: typeof d.isNasdaqListed === 'boolean' ? d.isNasdaqListed : null, lastTradeAt: parseTradeTime(p.lastTradeTimestamp),
    marketStatus: d.marketStatus ? String(d.marketStatus).slice(0, 20) : null,
  };
}
// a usable two-sided quote → spread in bps of the midpoint, else null
function spreadBps(bid, ask) {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return (ask - bid) / ((ask + bid) / 2) * 1e4;
}

// ---- statistics (pure) ----------------------------------------------------------------------------------------------------------
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const sortNum = a => [...a].sort((x, y) => x - y);
const median = a => quantile(sortNum(a), 0.5);

// rows: ok samples { symbol, spread_bps, minute_of_session, session_minutes, nasdaq_listed, sampled_at, last_trade_at }
function summarize(rows) {
  const bySymbol = new Map();
  for (const r of rows) { const a = bySymbol.get(r.symbol) || []; a.push(r.spread_bps); bySymbol.set(r.symbol, a); }
  const symbolMedians = sortNum([...bySymbol.values()].map(median));
  const win = r => (r.minute_of_session < 30 ? 'open' : r.minute_of_session >= r.session_minutes - 30 ? 'close' : 'mid');
  const byWindow = {};
  for (const w of ['open', 'mid', 'close']) {
    const a = rows.filter(r => win(r) === w).map(r => r.spread_bps);
    byWindow[w] = { samples: a.length, medianBps: median(a) };
  }
  const listed = (flag) => { const a = rows.filter(r => r.nasdaq_listed === flag).map(r => r.spread_bps); return { samples: a.length, medianBps: median(a) }; };
  const lags = rows.filter(r => r.last_trade_at).map(r => (r.sampled_at - r.last_trade_at) / 60000);
  return {
    samples: rows.length, symbols: bySymbol.size,
    // each symbol counts once (its own median), so heavily sampled names do not dominate: this is the figure to compare with the cost model
    roundTripMedianBps: quantile(symbolMedians, 0.5), roundTripP10Bps: quantile(symbolMedians, 0.1), roundTripP90Bps: quantile(symbolMedians, 0.9),
    meanAllSamplesBps: rows.length ? rows.reduce((s, r) => s + r.spread_bps, 0) / rows.length : null,
    byWindow, nasdaqListed: listed(1), otherListed: listed(0),
    lastTradeAgeMinMedian: median(lags), assumedBps: ASSUMED_BPS,
  };
}

function createSpreads({ fetcher, universe, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), opts = {} } = {}) {
  if (!fetcher || typeof fetcher.getText !== 'function') throw new TypeError('spreads needs a fetcher with getText(source, url, opts)');
  const o = { enabled: true, autoRun: true, everyMin: 15, perRound: 60, paceMs: 1000, maxFailRun: 3, startDelayMs: 20000, healthCacheMs: 30000, ...opts };
  let db = null, log = null, stopping = false, busy = false, tick = null, startTimer = null, lastCallAt = null, healthCache = null;

  async function fetchQuote(symbol) {
    if (lastCallAt !== null) { const wait = lastCallAt + o.paceMs - now(); if (wait > 0) await sleep(wait); }
    lastCallAt = now();
    let r;
    try { r = await fetcher.getText('finance', URL_FOR(symbol), { ttlMs: 0 }); } catch (err) { throw err instanceof StockmanError ? err : mapHttpError(err, 'api.nasdaq.com'); }
    if (r.stale) return { error: 'only an old cached copy was available' };
    let json;
    try { json = JSON.parse(r.data); } catch { return { error: 'the answer is not JSON' }; }
    const q = parseQuote(json);
    return q ? { quote: q } : { error: 'the answer is not in the expected shape' };
  }

  // which symbols to sample now: the current lists' symbols, least sampled today first, then least recently, then A to Z
  function pick(day, n) {
    const list = universe.symbols().map(s => s.symbol);
    const seen = new Map(db.stmt('SELECT symbol, COUNT(*) AS n, MAX(sampled_at) AS at FROM spread_sample WHERE day = ? GROUP BY symbol').all(day).map(r => [r.symbol, r]));
    return list.map(s => ({ s, n: Number(seen.get(s)?.n || 0), at: Number(seen.get(s)?.at || 0) }))
      .sort((a, b) => a.n - b.n || a.at - b.at || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)).slice(0, n).map(x => x.s);
  }

  const insert = () => db.stmt(`INSERT INTO spread_sample(symbol, day, sampled_at, minute_of_session, status, bid, ask, bid_size, ask_size, last, spread_bps,
    real_time, exchange, nasdaq_listed, last_trade_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const flag = b => (b === true ? 1 : b === false ? 0 : null);

  // one round. force: sample even outside the regular session (a test or the CLI; outside hours the quote is normally N/A)
  async function round({ force = false, limit = o.perRound } = {}) {
    if (!db) throw new StockmanError('spreads: not started');
    if (!o.enabled) return { status: 'off' };
    if (busy) return { status: 'busy' };
    const t0 = now();
    if (!force && !marketOpenNow(t0)) return { status: 'closed' };
    busy = true;
    const day = nyDate(t0), info = dayInfo(day);
    const openMs = info.open ? nyWallToMs(day, info.open) : null;
    const res = { status: 'done', day, asked: 0, ok: 0, noQuote: 0, failed: 0 };
    let failRun = 0;
    try {
      for (const symbol of pick(day, limit)) {
        if (stopping) { res.status = 'stopped'; break; }
        res.asked++;
        let got, err = null;
        try { got = await fetchQuote(symbol); } catch (e) { err = e; }
        const at = now(), mos = openMs === null ? null : Math.floor((at - openMs) / 60000);
        if (err instanceof PolicyError) { res.failed++; res.status = 'refused'; res.note = err.message; break; }   // finance is switched off: stop, write nothing
        if (err || got.error) {
          res.failed++; failRun++;
          insert().run(symbol, day, at, mos, 'failed', null, null, null, null, null, null, null, null, null, null, `${err?.code || 'SHAPE'}: ${String(err?.message || got.error).slice(0, 200)}`);
          if (failRun >= o.maxFailRun) { res.status = 'aborted'; res.note = 'three failures in a row'; break; }
          continue;
        }
        failRun = 0;
        const q = got.quote, bps = q.known ? spreadBps(q.bid, q.ask) : null;
        const status = bps === null ? 'no_quote' : 'ok';
        if (status === 'ok') res.ok++; else res.noQuote++;
        insert().run(symbol, day, at, mos, status, q.bid ?? null, q.ask ?? null, q.bidSize ?? null, q.askSize ?? null, q.last ?? null, bps,
          flag(q.realTime), q.exchange ?? null, flag(q.nasdaqListed), q.lastTradeAt ?? null, q.known ? (status === 'no_quote' ? `no two-sided quote (market ${q.marketStatus || '?'})` : null) : 'unknown to the provider');
      }
    } finally { busy = false; healthCache = null; }
    if (res.failed && log) log.warn('cost sampler round had failures', res);
    return res;
  }

  // the measured figures for New York days from..to (inclusive); default: every stored day
  function summary({ from = '0000-00-00', to = '9999-99-99' } = {}) {
    if (!db) throw new StockmanError('spreads: not started');
    const rows = db.stmt("SELECT symbol, day, spread_bps, minute_of_session, nasdaq_listed, sampled_at, last_trade_at FROM spread_sample WHERE status = 'ok' AND day >= ? AND day <= ?").all(from, to)
      .map(r => { const i = dayInfo(r.day); const len = i.open && i.close ? (nyWallToMs(r.day, i.close) - nyWallToMs(r.day, i.open)) / 60000 : 390; return { ...r, session_minutes: len }; });
    const c = db.stmt('SELECT status, COUNT(*) AS n FROM spread_sample WHERE day >= ? AND day <= ? GROUP BY status').all(from, to);
    const days = db.stmt('SELECT COUNT(DISTINCT day) AS n, MIN(day) AS a, MAX(day) AS b FROM spread_sample WHERE day >= ? AND day <= ?').get(from, to);
    return { ...summarize(rows), counts: Object.fromEntries(c.map(r => [r.status, Number(r.n)])), days: Number(days.n), firstDay: days.a, lastDay: days.b };
  }

  function health() {
    if (!db) return { summary: '' };
    const t = now();
    if (healthCache && t - healthCache.at < o.healthCacheMs) return healthCache.value;
    let value;
    try {
      const last = db.stmt('SELECT MAX(day) AS d FROM spread_sample').get().d;
      if (!o.enabled) value = { summary: 'cost sampler: OFF' };
      else if (!last) value = { summary: `cost sampler: no quotes yet (it samples bid and ask every ${o.everyMin} min during US market hours)` };
      else {
        const s = summary({ from: last, to: last });
        const f = x => (x === null ? 'n/a' : x.toFixed(1));
        value = {
          summary: `cost sampler ${last}: ${s.samples} two-sided quotes for ${s.symbols} symbols${s.counts.failed ? `, ${s.counts.failed} failed` : ''}; median quoted round-trip spread ${f(s.roundTripMedianBps)} bps per symbol (10% to 90% of symbols: ${f(s.roundTripP10Bps)} to ${f(s.roundTripP90Bps)}), the backtests assume ${ASSUMED_BPS} bps; quoted spread only, not size or the opening auction`,
          ...s,
        };
      }
    } catch (err) { value = { summary: '', error: String(err.message).slice(0, 200) }; }
    healthCache = { at: t, value };
    return value;
  }

  const api = { round, summary, health, pick, options: o };
  const feature = {
    id: 'spreads', migrations: [migration],
    async start(ctx) {
      db = ctx.db; log = ctx.log; stopping = false; healthCache = null;
      if (o.enabled && o.autoRun) {
        const go = () => { if (!busy && !stopping) round().catch(err => log?.warn('cost sampler round failed', { message: err.message })); };
        startTimer = setTimeout(() => { startTimer = null; go(); }, o.startDelayMs); startTimer.unref?.();
        tick = setInterval(go, o.everyMin * 60000); tick.unref?.();
      }
    },
    async stop() { stopping = true; clearTimeout(startTimer); clearInterval(tick); startTimer = tick = null; },
    health,
  };
  return { feature, api };
}

module.exports = { createSpreads, parseQuote, parseTradeTime, spreadBps, summarize, quantile, MIGRATION_VERSION, URL_FOR };
