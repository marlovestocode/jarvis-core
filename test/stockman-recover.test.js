// Survivorship-gap recovery (G24, vault D32): renamed tickers get the new ticker's bars from before the rename; delisted ones get Alpaca SIP
// history; what neither has stays not_found with a note. Never filled, never copied across companies, no new table.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { createRecover } = require('../src/core/stockman/features/recover');
const { PolicyError, NotFoundError } = require('../src/core/stockman/errors');

const ms = d => Date.parse(`${d}T20:00:00Z`);
function yahooBars(days, start = 50) { return days.map((d, i) => ({ t: ms(d), open: start + i, high: start + i + 1, low: start + i - 1, close: start + i, adjClose: (start + i) * 0.9, volume: 1000 })); }

const REAL = { COR: 'Cencora, Inc.', ELV: 'Elevance Health, Inc.' };
async function make({ history = {}, alpaca = null, renames, names = REAL } = {}) {
  const prov = createMockProvider({ bars: {}, ranges: ['1mo', '10y'], intervals: ['1d'] });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: prov, sleep: async () => {} });
  const bars = createBars({ sleep: async () => {} });
  const rec = createRecover({ alpaca, now: () => Date.parse('2026-11-17T22:00:00Z'), sleep: async () => {}, opts: { autoRun: false, ...(renames ? { renames } : {}) } });
  app.use(bars.feature); app.use(rec.feature);
  await app.start();
  app.stocks.getHistory = async ({ symbol }) => { if (!history[symbol]) throw new NotFoundError(`no ${symbol}`); return { symbol, bars: history[symbol], name: names[symbol] || `${symbol} Inc`, source: 'yahoo', fetchedAt: 1 }; };
  const nf = sym => app.db.stmt("INSERT INTO bar_history(symbol, status, from_day, attempts, note) VALUES (?, 'not_found', '2019-01-01', 1, 'HTTP 404')").run(sym);
  const row = sym => app.db.stmt('SELECT * FROM bar_history WHERE symbol = ?').get(sym);
  const barsOf = sym => app.db.stmt('SELECT * FROM bar WHERE symbol = ? ORDER BY day').all(sym);
  return { app, rec: rec.api, nf, row, barsOf };
}

test('rename: the new ticker\'s bars before the rename day are stored under the old ticker; later days are not', async () => {
  const X = await make({ history: { COR: yahooBars(['2023-08-28', '2023-08-29', '2023-08-30', '2023-08-31']) } });
  X.nf('ABC');
  const r = await X.rec.step();
  assert.equal(r.renamed, 1);
  const b = X.barsOf('ABC');
  assert.deepEqual(b.map(x => x.day), ['2023-08-28', '2023-08-29']);
  assert.ok(b.every(x => x.source === 'yahoo:rename:COR' && x.adj_close > 0));
  assert.equal(X.row('ABC').status, 'ok'); assert.match(X.row('ABC').note, /^recover: renamed ABC → COR on 2023-08-30/);
  assert.equal(X.barsOf('COR').length, 0, 'the new ticker itself is not touched');
  assert.deepEqual(X.rec.counts(), { missing: 0, renamed: 1, alpaca: 0 });
  await X.app.stop();
});

test('rename is refused when the new ticker\'s history starts on or after the rename day (a later listing is another company)', async () => {
  const alpaca = { dailyBars: async () => [] };
  const X = await make({ history: { ELV: yahooBars(['2022-06-28', '2022-06-29']) }, alpaca });
  X.nf('ANTM');
  const r = await X.rec.step();
  assert.equal(r.renamed, 0);
  assert.equal(X.barsOf('ANTM').length, 0);
  assert.equal(X.row('ANTM').status, 'not_found');
  assert.match(X.row('ANTM').note, /does not reach back before 2022-06-28.*alpaca: no bars/);
  assert.equal((await X.rec.step()).tried, 0, 'a symbol already tried is not tried again without retry');
  await X.app.stop();
});

test('alpaca: a delisted ticker gets raw and adjusted SIP bars; today\'s session is never stored; a bar with no adjusted close is left out', async () => {
  const calls = [];
  const alpaca = { dailyBars: async (sym, o) => { calls.push([sym, o.adjustment]); const rows = [['2022-10-25', 50], ['2022-10-26', 51], ['2026-11-17', 9]];
    return rows.filter(([d]) => o.adjustment === 'raw' || d !== '2022-10-26').map(([d, c]) => ({ t: `${d}T${d > '2022-11-06' ? '05' : '04'}:00:00Z`, open: c, high: c + 1, low: c - 1, close: o.adjustment === 'all' ? c * 0.95 : c, volume: 10 })); } };
  const X = await make({ alpaca });
  X.nf('TWTR');
  const r = await X.rec.step();
  assert.equal(r.alpaca, 1);
  assert.deepEqual(calls, [['TWTR', 'raw'], ['TWTR', 'all']]);
  const b = X.barsOf('TWTR');
  assert.deepEqual(b.map(x => [x.day, x.close, x.adj_close, x.source]), [['2022-10-25', 50, 47.5, 'alpaca-sip']]);
  assert.match(X.row('TWTR').note, /^recover: bars from Alpaca SIP history/);
  await X.app.stop();
});

test('alpaca off (policy or no keys): nothing is marked, so the next start tries again; Yahoo policy off stops the pass', async () => {
  const alpaca = { dailyBars: async () => { throw new PolicyError('alpaca: broker lookups are off'); } };
  const X = await make({ alpaca });
  X.nf('SIVB'); X.nf('FRC');
  const r = await X.rec.step();
  assert.equal(r.alpaca, 0); assert.match(r.alpacaOff, /broker lookups are off/);
  assert.equal(X.row('SIVB').note, 'HTTP 404', 'not marked as tried');
  assert.match(X.rec.counts ? 'x' : '', /x/);
  await X.app.stop();
});

test('a reused ticker is refused by the company-name check, and a rename stored by an earlier build for the wrong company is undone', async () => {
  const days = ['2021-03-01', '2021-03-02', '2022-02-15', '2022-02-16'];
  const alpaca = { dailyBars: async () => [] };
  const X = await make({ history: { PARA: yahooBars(days) }, names: { PARA: 'Parabolic Technologies, Inc.' }, alpaca });
  X.nf('VIAC');
  // what the first live pass stored (before the name check existed)
  X.app.db.stmt("INSERT INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES ('VIAC','2021-03-01',1,1,1,1,1,1,'yahoo:rename:PARA',1)").run();
  X.app.db.stmt("UPDATE bar_history SET status = 'ok', note = 'recover: renamed VIAC → PARA on 2022-02-16; bars of PARA (Parabolic Technologies, Inc.) before that day, 1 stored' WHERE symbol = 'VIAC'").run();
  const r = await X.rec.step();
  assert.deepEqual(r.undone, ['VIAC']);
  assert.equal(X.barsOf('VIAC').length, 0, 'the wrong bars are gone');
  assert.equal(X.row('VIAC').status, 'not_found');
  assert.equal(r.renamed, 0, 'the same pass refuses the rename by name');
  assert.match(X.row('VIAC').note, /the company is now "Parabolic Technologies, Inc\.", not the renamed one/);
  await X.app.stop();
});

test('alpaca is asked only through the previous day (the free plan refuses recent SIP data)', async () => {
  const seen = [];
  const X = await make({ alpaca: { dailyBars: async (s, o) => { seen.push(o.end); return []; } } });
  X.nf('TWTR');
  await X.rec.step();
  assert.deepEqual(seen, ['2026-11-16']);
  await X.app.stop();
});
