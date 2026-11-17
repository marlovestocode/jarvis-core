// Feature "options", the options market sampler (vault note 06 cost model, CL-0068): while the US regular session is open it reads the quoted bid,
// ask, implied volatility and delta of near-the-money option contracts on a short list of liquid underlyings and stores them, so the real cost
// of trading options (the quoted spread, as a share of the option's price) is MEASURED before any options rule is written. READ-ONLY: it places
// no order and cannot (it holds only the adapter's read methods).
//   source: Alpaca market data, GET https://data.alpaca.markets/v1beta1/options/snapshots/{underlying}?feed=indicative&limit=1000
//           &type=&expiration_date_lte=&strike_price_gte=&strike_price_lte= (+ next_page_token), through trading/alpaca.js (paper keys from the
//           environment, source 'broker', online.broker). Shape seen live 2026-11-17 14:15 ET on the user's paper account:
//           { snapshots: { 'AAPL261125C00350000': { latestQuote: { ap, as, bp, bs, t }, latestTrade: { p, t }, dailyBar: { v, ... },
//             greeks: { delta, gamma, theta, vega, rho }, impliedVolatility } }, next_page_token }. The paper account showed options level 3.
//   honest limits: the free 'indicative' feed is Alpaca's derived, not the consolidated OPRA, so its quotes can be wider or staler than what a
//           real order would see (the sample stores the quote's age); a quoted spread is not the whole cost (a real fill, size, and the
//           paper account's simulated fills are not in it); an option's price moves fast, so every figure is shown with the sample count.
//   plan:   every `everyMin` minutes in the regular session, per underlying: its stock mid, then contracts expiring within `expiryDays` and
//           with strikes within `strikeBand` of the stock, nearest the money first, at most `perUnderlying` per round (calls and puts). Three
//           failures in a row or a policy refusal end the round. Nothing is filled or guessed.
const { nyDate, nyWallToMs } = require('./ny-time');
const { dayInfo, marketOpenNow } = require('./calendar-rules');
const { PolicyError, StockmanError } = require('../errors');

const MIGRATION_VERSION = 13;
const UNDERLYINGS = Object.freeze(['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'AVGO', 'JPM', 'NFLX', 'BAC', 'XOM', 'WMT', 'V', 'COST', 'CRM', 'ORCL']);

const migration = {
  version: MIGRATION_VERSION, name: 'options-samples',
  up(raw) {
    raw.exec(`
      -- one row per contract quote seen. spread_pct = (ask - bid) / mid, the share of the option's price a round trip at the quote would cost.
      CREATE TABLE option_sample(
        id INTEGER PRIMARY KEY,
        day TEXT NOT NULL, sampled_at INTEGER NOT NULL, minute_of_session INTEGER,
        underlying TEXT NOT NULL, contract TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('call','put')),
        expiry TEXT NOT NULL, dte INTEGER NOT NULL, strike REAL NOT NULL, under_price REAL NOT NULL, moneyness REAL NOT NULL,
        bid REAL NOT NULL, ask REAL NOT NULL, bid_size INTEGER, ask_size INTEGER, mid REAL NOT NULL, spread_abs REAL NOT NULL, spread_pct REAL NOT NULL,
        iv REAL, delta REAL, volume INTEGER, last REAL, quote_age_s INTEGER);
      CREATE INDEX option_sample_day ON option_sample(day, underlying);
      CREATE INDEX option_sample_contract ON option_sample(contract, sampled_at);
    `);
  },
};

// OCC symbol AAPL261125C00350000 → { root, expiry '2026-11-25', kind, strike 350 }, or null
function parseOcc(sym) {
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym));
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, kind: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };

// one snapshot (the provider's JSON for a contract) → a row, or null when it has no two-sided quote or is not what was seen
function toRow(contract, snap, { underPrice, day, at, today }) {
  const occ = parseOcc(contract);
  const q = snap?.latestQuote;
  if (!occ || !q) return null;
  const bid = fin(q.bp), ask = fin(q.ap);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  const t = Date.parse(q.t || '');
  return {
    day, at, underlying: occ.root, contract, kind: occ.kind, expiry: occ.expiry, dte: daysBetween(today, occ.expiry), strike: occ.strike, underPrice,
    moneyness: occ.strike / underPrice - 1, bid, ask, bidSize: fin(q.bs), askSize: fin(q.as), mid, spreadAbs: ask - bid, spreadPct: (ask - bid) / mid,
    iv: fin(snap.impliedVolatility), delta: fin(snap.greeks?.delta), volume: fin(snap.dailyBar?.v), last: fin(snap.latestTrade?.p),
    quoteAgeS: Number.isFinite(t) ? Math.max(0, Math.round((at - t) / 1000)) : null,
  };
}
// the contracts to keep from one underlying's snapshots: nearest the money first (then the nearer expiry), at most `n`
function pickNearest(rows, n) {
  return [...rows].sort((a, b) => Math.abs(a.moneyness) - Math.abs(b.moneyness) || a.dte - b.dte || (a.contract < b.contract ? -1 : 1)).slice(0, n);
}

function createOptions({ alpaca, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), opts = {} } = {}) {
  if (!alpaca || typeof alpaca.optionSnapshots !== 'function' || typeof alpaca.stockMid !== 'function') throw new TypeError('options needs the Alpaca adapter (read methods)');
  const o = { enabled: true, autoRun: true, underlyings: UNDERLYINGS, everyMin: 15, expiryDays: 35, strikeBand: 0.06, perUnderlying: 60, maxPages: 3, paceMs: 700, maxFailRun: 3, startDelayMs: 45000, healthCacheMs: 30000, keepDays: 90, ...opts };
  let db = null, log = null, stopping = false, busy = false, tick = null, startTimer = null, healthCache = null;

  const insert = () => db.stmt(`INSERT INTO option_sample(day, sampled_at, minute_of_session, underlying, contract, kind, expiry, dte, strike, under_price, moneyness, bid, ask, bid_size, ask_size, mid,
    spread_abs, spread_pct, iv, delta, volume, last, quote_age_s) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  async function round({ force = false, only = null } = {}) {
    if (!db) throw new StockmanError('options: not started');
    if (!o.enabled) return { status: 'off' };
    if (busy) return { status: 'busy' };
    const t0 = now();
    if (!force && !marketOpenNow(t0)) return { status: 'closed' };
    busy = true;
    const day = nyDate(t0), info = dayInfo(day), openMs = info.open ? nyWallToMs(day, info.open) : null;
    const res = { status: 'done', day, underlyings: 0, contracts: 0, failed: 0 };
    let failRun = 0;
    try {
      for (const u of (only || o.underlyings)) {
        if (stopping) { res.status = 'stopped'; break; }
        try {
          if (res.underlyings) await sleep(o.paceMs);
          const under = await alpaca.stockMid(u);
          const hi = new Date(t0 + o.expiryDays * 86400000).toISOString().slice(0, 10);
          const all = [];
          let token = null;
          for (let page = 0; page < o.maxPages; page++) {
            const r = await alpaca.optionSnapshots({ underlying: u, expiryLte: hi, strikeGte: Math.floor(under * (1 - o.strikeBand)), strikeLte: Math.ceil(under * (1 + o.strikeBand)), pageToken: token });
            const at = now();
            for (const [c, s] of Object.entries(r.snapshots)) { const row = toRow(c, s, { underPrice: under, day, at, today: day }); if (row && row.dte >= 0) all.push(row); }
            token = r.nextPageToken;
            if (!token) break;
            await sleep(o.paceMs);
          }
          const keep = pickNearest(all, o.perUnderlying);
          const mos = openMs === null ? null : Math.floor((now() - openMs) / 60000);
          const ins = insert();
          db.tx(() => { for (const r of keep) ins.run(r.day, r.at, mos, r.underlying, r.contract, r.kind, r.expiry, r.dte, r.strike, r.underPrice, r.moneyness, r.bid, r.ask, r.bidSize, r.askSize, r.mid, r.spreadAbs, r.spreadPct, r.iv, r.delta, r.volume, r.last, r.quoteAgeS); });
          res.underlyings++; res.contracts += keep.length; failRun = 0;
        } catch (err) {
          if (err instanceof PolicyError) { res.status = 'refused'; res.note = err.message; break; }   // broker source off or no keys: stop, write nothing
          res.failed++; failRun++;
          log?.warn?.('options sampler: one underlying failed', { underlying: u, message: String(err.message).slice(0, 200) });
          if (failRun >= o.maxFailRun) { res.status = 'aborted'; res.note = 'three failures in a row'; break; }
        }
      }
    } finally { busy = false; healthCache = null; }
    return res;
  }

  // measured figures for the New York days from..to. ATM-ish = |delta| between 0.3 and 0.7 when delta is known, else |moneyness| under 2%.
  function summary({ from = '0000-00-00', to = '9999-99-99' } = {}) {
    if (!db) throw new StockmanError('options: not started');
    const rows = db.stmt('SELECT underlying, kind, dte, moneyness, spread_pct AS sp, spread_abs AS sa, mid, delta, quote_age_s AS age FROM option_sample WHERE day >= ? AND day <= ?').all(from, to);
    const atm = rows.filter(r => (r.delta !== null ? Math.abs(r.delta) >= 0.3 && Math.abs(r.delta) <= 0.7 : Math.abs(r.moneyness) < 0.02));
    const med = (list, f) => quantile(list.map(f), 0.5);
    const bucket = (lo, hi) => { const a = atm.filter(r => r.dte >= lo && r.dte <= hi); return { samples: a.length, medianSpreadPct: med(a, r => r.sp), medianSpreadAbs: med(a, r => r.sa), medianMid: med(a, r => r.mid) }; };
    const byU = new Map();
    for (const r of atm) { const a = byU.get(r.underlying) || []; a.push(r.sp); byU.set(r.underlying, a); }
    const perUnderlying = [...byU.entries()].map(([underlying, a]) => ({ underlying, samples: a.length, medianSpreadPct: quantile(a, 0.5) })).sort((x, y) => x.medianSpreadPct - y.medianSpreadPct);
    const days = db.stmt('SELECT COUNT(DISTINCT day) AS n, MIN(day) AS a, MAX(day) AS b FROM option_sample WHERE day >= ? AND day <= ?').get(from, to);
    return {
      samples: rows.length, atmSamples: atm.length, underlyings: byU.size, days: Number(days.n), firstDay: days.a, lastDay: days.b,
      medianSpreadPct: med(atm, r => r.sp), shareOver10Pct: atm.length ? atm.filter(r => r.sp > 0.10).length / atm.length : null,
      medianQuoteAgeS: med(rows.filter(r => r.age !== null), r => r.age),
      byDte: { '0-7': bucket(0, 7), '8-21': bucket(8, 21), '22-35': bucket(22, 35) },
      byKind: { call: (() => { const a = atm.filter(r => r.kind === 'call'); return { samples: a.length, medianSpreadPct: med(a, r => r.sp) }; })(), put: (() => { const a = atm.filter(r => r.kind === 'put'); return { samples: a.length, medianSpreadPct: med(a, r => r.sp) }; })() },
      perUnderlying,
    };
  }
  function health() {
    if (!db) return { summary: '' };
    const t = now();
    if (healthCache && t - healthCache.at < o.healthCacheMs) return healthCache.value;
    let value;
    try {
      const last = db.stmt('SELECT MAX(day) AS d FROM option_sample').get().d;
      if (!o.enabled) value = { summary: 'options sampler: OFF' };
      else if (!last) value = { summary: `options sampler: no quotes yet (every ${o.everyMin} min in market hours; needs online.broker and the Alpaca paper keys)` };
      else {
        const s = summary({ from: last, to: last }), f = (x, d = 1) => (x === null ? 'n/a' : (x * 100).toFixed(d));
        value = { summary: `options sampler ${last}: ${s.samples} contract quotes on ${s.underlyings} underlyings; median quoted round-trip cost near the money ${f(s.medianSpreadPct)}% of the option price (${f(s.shareOver10Pct, 0)}% of quotes over 10%); indicative feed, quoted spread only`, ...s };
      }
    } catch (err) { value = { summary: '', error: String(err.message).slice(0, 200) }; }
    healthCache = { at: t, value };
    return value;
  }

  const api = { round, summary, health, options: o };
  const feature = {
    id: 'options', migrations: [migration],
    async start(ctx) {
      db = ctx.db; log = ctx.log; stopping = false; healthCache = null;
      try { db.stmt('DELETE FROM option_sample WHERE sampled_at < ?').run(now() - o.keepDays * 86400000); } catch { /* the next start will try again */ }
      if (o.enabled && o.autoRun) {
        const go = () => { if (!busy && !stopping) round().catch(err => log?.warn?.('options sampler round failed', { message: err.message })); };
        startTimer = setTimeout(() => { startTimer = null; go(); }, o.startDelayMs); startTimer.unref?.();
        tick = setInterval(go, o.everyMin * 60000); tick.unref?.();
      }
    },
    async stop() { stopping = true; clearTimeout(startTimer); clearInterval(tick); startTimer = tick = null; },
    health,
  };
  return { feature, api };
}

module.exports = { createOptions, parseOcc, toRow, pickNearest, MIGRATION_VERSION, UNDERLYINGS };
