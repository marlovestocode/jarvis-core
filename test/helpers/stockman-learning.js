// Shared setup for the learning-layer tests (scoring, shadow, calibration): an in-memory stockman.db with the bars feature and the three
// learning features, a fake universe, run table and earnings (the data layer's APIs are replaced by these small stand-ins), and synthetic bars.
const os = require('node:os');
const { createStockman } = require('../../src/core/stockman/app');
const { createMockProvider } = require('../../src/core/stockman/stocks/mock');
const { createBars } = require('../../src/core/stockman/features/bars');
const { createLearningLayer } = require('../../src/core/stockman/learning');
const { tradingDays } = require('../../src/core/stockman/features/calendar-rules');
const { nyWallToMs } = require('../../src/core/stockman/features/ny-time');

// a deterministic pseudo-random sequence in [-1, 1) (no Math.random anywhere in the tests)
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1; }; }
const hash = str => { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };

// a clock that moves a little on every read and can be set
function clock(iso) { let t = Date.parse(iso); const now = () => (t += 1); now.set = i => { t = Date.parse(i); }; now.jump = ms => { t += ms; }; return now; }

// insert bars: price(i, day) → close; open = 0.999 close, adjusted close = factor * close (factor can change by day to mimic a dividend)
function putBars(app, symbol, days, { price, factor = () => 0.98, skip = [] } = {}) {
  const ins = app.db.stmt('INSERT OR REPLACE INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  app.db.tx(() => days.forEach((d, i) => {
    if (skip.includes(d)) return;
    const c = price(i, d);
    ins.run(symbol, d, c * 0.999, c * 1.01, c * 0.99, c, c * factor(i, d), 1000, 'test', 1);
  }));
}
// a random-walk price path starting at `start`, seeded by the symbol
const walk = (symbol, start = 100, vol = 0.01) => { const rnd = lcg(hash(symbol)); let p = start; const cache = []; return i => { while (cache.length <= i) { p *= 1 + vol * rnd(); cache.push(p); } return cache[i]; }; };

// members: symbols in the fake universe. run: day → state (default 'ingested'). flags: (symbol, entry, exit) → earnings flags | null
async function makeLearning({ members = [], runState = () => 'ingested', flags = null, now = clock('2026-11-24T01:00:00Z'), shadowOpts = {}, calibrationOpts = {}, dbFile = ':memory:' } = {}) {
  const prov = createMockProvider({ bars: {}, ranges: ['1mo'], intervals: ['1d'], now });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile, log: () => {}, provider: prov, now, sleep: async () => {} });
  const bars = createBars({ now, sleep: async () => {} });
  const state = { members: [...members], runState, flags, memberCalls: [] };
  const data = {
    bars: bars.api,
    universe: { membersAsOf: day => { state.memberCalls.push(day); return { sp500: { snapshotAsOf: '2026-10-01', kind: 'history', symbols: [...state.members] }, ndx100: null }; } },
    runs: { getRun: day => { const s = state.runState(day); return s ? { run_id: `run-${day}`, trade_day: day, state: s } : null; } },
    earnings: { flags: ({ symbol, entryDay, exitDay }) => (state.flags ? state.flags(symbol, entryDay, exitDay) : { earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed' }) },
  };
  const layer = createLearningLayer({ data, now, autoRun: false, options: { shadow: { momentum: false, ...shadowOpts }, calibration: calibrationOpts } });
  app.use(bars.feature);
  for (const f of layer.features) app.use(f);
  await app.start();
  return { app, bars, layer, api: layer.api, scoring: layer.api.scoring, shadow: layer.api.shadow, calibration: layer.api.calibration, state, now };
}

const one = (app, sql, ...a) => app.db.stmt(sql).get(...a);
const count = (app, sql, ...a) => Number(one(app, sql, ...a).n);

module.exports = { lcg, hash, clock, putBars, walk, makeLearning, one, count, tradingDays, nyWallToMs };
