'use strict';
// Survivorship-gap recovery (G24, vault D32). No table, no migration: it works on bar_history rows with status 'not_found' and writes
// bars under the OLD ticker (the one the point-in-time index lists use), so the backtest and the shadow log find them unchanged.
//
// 1. Rename map: a ticker that changed while the company stayed the same (ABC → COR, ANTM → ELV, ...). The new ticker's whole history is
//    fetched from Yahoo and stored under the old ticker for days up to the rename. A rename is used only if the new series really
//    reaches back before the rename (a later listing would be a different company). Mergers and acquisitions are NOT renames and are
//    left out of the map on purpose: their bars belong to a different company.
// 2. Alpaca historical bars (read-only, data.alpaca.markets, already allowlisted under online.broker): for what is still missing, raw
//    and split-and-dividend adjusted daily bars from the SIP feed, which keeps symbols that no longer trade.
// What neither source has stays 'not_found' with a note: a recorded gap, never filled, copied from another symbol or interpolated.
// Every series comes from ONE source, so its adjusted closes are on one basis; `bar.source` says which (yahoo:rename:NEW or alpaca-sip).

const { PolicyError } = require('../errors');
const { nyDate } = require('./ny-time');

// old ticker → { to, on: the first day under the new ticker }. Only renames of the same listed company, from public filings known
// before 2026; each is still checked against the data (the new series must reach back before `on`).
const RENAMES = Object.freeze({
  ABC: { to: 'COR', on: '2023-08-30' },    // AmerisourceBergen → Cencora
  ANTM: { to: 'ELV', on: '2022-06-28' },   // Anthem → Elevance Health
  BLL: { to: 'BALL', on: '2022-05-04' },   // Ball Corporation ticker change
  CDAY: { to: 'DAY', on: '2024-02-01' },   // Ceridian → Dayforce
  FBHS: { to: 'FBIN', on: '2022-12-15' },  // Fortune Brands Home & Security → Fortune Brands Innovations
  FLT: { to: 'CPAY', on: '2024-03-25' },   // FleetCor → Corpay
  HFC: { to: 'DINO', on: '2022-03-14' },   // HollyFrontier → HF Sinclair (holding company of the same business)
  NLOK: { to: 'GEN', on: '2022-11-08' },   // NortonLifeLock → Gen Digital
  PEAK: { to: 'DOC', on: '2024-03-01' },   // Healthpeak (the surviving company) took the ticker DOC
  PKI: { to: 'RVTY', on: '2023-05-17' },   // PerkinElmer → Revvity
  RE: { to: 'EG', on: '2023-07-10' },      // Everest Re → Everest Group
  WLTW: { to: 'WTW', on: '2022-01-13' },   // Willis Towers Watson ticker change
  VIAC: { to: 'PARA', on: '2022-02-16' },  // ViacomCBS → Paramount Global
  CTL: { to: 'LUMN', on: '2020-09-18' },   // CenturyLink → Lumen
  ADS: { to: 'BFH', on: '2022-03-23' },    // Alliance Data → Bread Financial
  ARNC: { to: 'HWM', on: '2020-04-01' },   // Arconic Inc. → Howmet Aerospace (the old Arconic Inc. renamed)
  COG: { to: 'CTRA', on: '2021-10-01' },   // Cabot Oil & Gas → Coterra
  UTX: { to: 'RTX', on: '2020-04-03' },    // United Technologies (the surviving company) → Raytheon Technologies
  GPS: { to: 'GAP', on: '2024-08-22' },    // Gap Inc. ticker change
});
const MARK = 'recover:';
// Alpaca stamps a daily bar at midnight New York time (04:00Z in summer, 05:00Z in winter); read the date at midday so it never slips a day
const barDay = t => nyDate(Date.parse(t) + 12 * 3600_000);

function createRecover({ alpaca = null, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), opts = {} } = {}) {
  const o = { autoRun: true, startDelayMs: 120_000, paceMs: 1000, from: '2019-01-01', renames: RENAMES, ...opts };
  let db = null, stocks = null, log = null, timer = null, busy = false, stopping = false, last = null;

  const pending = () => db.stmt("SELECT symbol, note FROM bar_history WHERE status = 'not_found' ORDER BY symbol").all();
  const today = () => nyDate(now());

  function write(symbol, bars, source) {
    const up = db.stmt(`INSERT INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol, day) DO NOTHING`);
    let n = 0;
    db.tx(() => { for (const b of bars) n += Number(up.run(symbol, b.day, b.open, b.high, b.low, b.close, b.adj, b.volume ?? null, source, now()).changes); });
    return n;
  }
  function markOk(symbol, bars, provider, note) {
    const days = bars.map(b => b.day).sort();
    db.stmt(`UPDATE bar_history SET status = 'ok', first_day = ?, last_day = ?, n = ?, provider_name = ?, fetched_at = ?, note = ? WHERE symbol = ?`)
      .run(days[0], days.at(-1), bars.length, provider, now(), `${MARK} ${note}`.slice(0, 300), symbol);
  }
  function markTried(symbol, note) {
    db.stmt(`UPDATE bar_history SET fetched_at = ?, note = ? WHERE symbol = ? AND status = 'not_found'`).run(now(), `${MARK} ${note}`.slice(0, 300), symbol);
  }

  async function viaRename(symbol) {
    const r = o.renames[symbol];
    if (!r || !stocks) return null;
    let h;
    try { h = await stocks.getHistory({ symbol: r.to, range: '10y', interval: '1d' }); } catch (err) { if (err.code === 'POLICY') throw err; return { tried: `rename to ${r.to}: ${err.code || 'error'}` }; }
    const bars = (h?.bars || []).map(b => ({ day: nyDate(b.t), open: b.open, high: b.high, low: b.low, close: b.close, adj: b.adjClose, volume: b.volume }))
      .filter(b => b.day >= o.from && b.day < r.on && b.close > 0 && b.adj > 0);
    // continuity check: the new ticker's history must start before the rename (otherwise it is a different, later listing)
    if (!bars.length || bars[0].day >= r.on) return { tried: `rename to ${r.to}: its history does not reach back before ${r.on}` };
    const n = write(symbol, bars, `yahoo:rename:${r.to}`);
    markOk(symbol, bars, 'yahoo', `renamed ${symbol} → ${r.to} on ${r.on}; bars of ${r.to}${h.name ? ` (${String(h.name).slice(0, 60)})` : ''} before that day, ${n} stored`);
    return { ok: true, n, via: `rename:${r.to}` };
  }

  async function viaAlpaca(symbol) {
    if (!alpaca || typeof alpaca.dailyBars !== 'function') return { tried: 'alpaca not available' };
    const end = today();
    const raw = await alpaca.dailyBars(symbol, { start: o.from, end, adjustment: 'raw' });
    if (!raw.length) return { tried: 'alpaca: no bars' };
    await sleep(o.paceMs);
    const adj = new Map((await alpaca.dailyBars(symbol, { start: o.from, end, adjustment: 'all' })).map(b => [barDay(b.t), b.close]));
    const bars = raw.map(b => ({ day: barDay(b.t), open: b.open, high: b.high, low: b.low, close: b.close, adj: adj.get(barDay(b.t)) ?? null, volume: b.volume }))
      .filter(b => b.day < end && b.adj > 0);   // a bar with no adjusted close is left out, never guessed; today's session is never stored
    if (!bars.length) return { tried: 'alpaca: no bars with an adjusted close' };
    const n = write(symbol, bars, 'alpaca-sip');
    markOk(symbol, bars, 'alpaca', `bars from Alpaca SIP history (raw and adjusted), ${n} stored`);
    return { ok: true, n, via: 'alpaca' };
  }

  // one pass over the not_found symbols. A symbol already tried (note starts with recover:) is skipped unless `retry`.
  async function step({ retry = false, limit = 200 } = {}) {
    if (!db) return { status: 'off' };
    if (busy) return { status: 'busy' };
    busy = true;
    const res = { status: 'ok', at: now(), tried: 0, renamed: 0, alpaca: 0, stillMissing: 0, stopped: null, details: [] };
    try {
      let alpacaOk = Boolean(alpaca);
      for (const row of pending().slice(0, limit)) {
        if (stopping) { res.stopped = 'stopping'; break; }
        if (!retry && String(row.note || '').startsWith(MARK)) { res.stillMissing++; continue; }
        res.tried++;
        let out = null;
        try { out = await viaRename(row.symbol); } catch (err) { if (err.code === 'POLICY' || err instanceof PolicyError) { res.stopped = 'policy: market data is off'; break; } out = { tried: String(err.message).slice(0, 80) }; }
        if (out?.ok) { res.renamed++; res.details.push({ symbol: row.symbol, ...out }); await sleep(o.paceMs); continue; }
        const why = [out?.tried].filter(Boolean);
        if (alpacaOk) {
          try { const a = await viaAlpaca(row.symbol); if (a.ok) { res.alpaca++; res.details.push({ symbol: row.symbol, ...a }); await sleep(o.paceMs); continue; } why.push(a.tried); }
          catch (err) {
            if (err instanceof PolicyError || err.code === 'POLICY' || err.code === 'CONFIG') { alpacaOk = false; res.alpacaOff = String(err.message).slice(0, 120); why.push('alpaca off'); res.stillMissing++; continue; }   // not marked: retried at the next start
            why.push(`alpaca: ${String(err.message).slice(0, 80)}`);
          }
          await sleep(o.paceMs);
        } else { res.stillMissing++; continue; }
        markTried(row.symbol, `no bars found: ${why.join('; ')}`);
        res.stillMissing++;
      }
    } catch (err) {
      res.status = 'error'; res.note = String(err.message).slice(0, 200); log?.warn?.('survivorship recovery failed', { message: res.note });
    } finally { busy = false; }
    last = res;
    if (res.renamed || res.alpaca) log?.info?.('survivorship recovery', { renamed: res.renamed, alpaca: res.alpaca, stillMissing: res.stillMissing });
    return res;
  }

  function counts() {
    if (!db) return null;
    const r = db.stmt(`SELECT
        SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) AS missing,
        SUM(CASE WHEN status = 'ok' AND note LIKE 'recover: renamed%' THEN 1 ELSE 0 END) AS renamed,
        SUM(CASE WHEN status = 'ok' AND note LIKE 'recover: bars from Alpaca%' THEN 1 ELSE 0 END) AS alpaca FROM bar_history`).get();
    return { missing: Number(r.missing) || 0, renamed: Number(r.renamed) || 0, alpaca: Number(r.alpaca) || 0 };
  }
  function health() {
    const c = counts();
    if (!c) return { summary: '' };
    return { summary: `survivorship (G24): ${c.renamed} recovered by rename, ${c.alpaca} from Alpaca history, ${c.missing} still without bars (a recorded gap)${last?.alpacaOff ? `; Alpaca off: ${last.alpacaOff}` : ''}` };
  }

  const api = { step, counts, RENAMES: o.renames };
  const feature = {
    id: 'recover',
    async start(ctx) {
      db = ctx.db; stocks = ctx.stocks; log = ctx.log; stopping = false;
      if (o.autoRun) { timer = setTimeout(() => { timer = null; step().catch(err => log?.warn?.('survivorship recovery failed', { message: err.message })); }, o.startDelayMs); timer.unref?.(); }
    },
    async stop() { stopping = true; clearTimeout(timer); timer = null; },
    health,
  };
  return { feature, api };
}

module.exports = { createRecover, RENAMES };
