// The StockMan dashboard (CL-0066): the state the engine builds (jarvis/dashboard.js), the bridge routes that serve the page and its numbers,
// and the page's own safety (same-origin only, no inline script or style, no innerHTML). Synthetic data, in-memory database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createBus } = require('../src/core/bus');
const { startBridge } = require('../src/core/bridge');
const { buildState, forwardResults } = require('../src/core/stockman/jarvis/dashboard');
const { MOM_BUILD, SCORING_BUILD } = require('../src/core/stockman/learning/scoring');
const { makeLearning, putBars, walk, tradingDays, one } = require('./helpers/stockman-learning');

const D = '2026-11-16', ENTRY = '2026-11-17', EXIT = '2026-11-23';
const HISTORY = tradingDays('2025-04-01', '2026-11-30');
const SYMS = ['A', 'B', 'C', 'D', 'E', 'F'];

async function learned() {
  const L = await makeLearning({ members: SYMS, shadowOpts: { momentum: true } });
  SYMS.forEach((s, k) => putBars(L.app, s, HISTORY, { price: (i, d) => (d === ENTRY ? 100 : d === EXIT ? 100 + (k + 1) * 2 : walk(s, 40 + k * 7, 0.012)(i)) }));
  putBars(L.app, 'SPY', HISTORY, { price: (i, d) => (d === ENTRY ? 400 : d === EXIT ? 404 : 400 + (i % 5)), factor: () => 1 });
  L.shadow.logDay(D); L.shadow.logDay(D, { rule: 'momentum' }); L.shadow.resolveOutcomes();
  return L;
}

test('forward results: each variant\'s top-20 basket mean excess is the mean of its filled outcomes, gross and after 10 bps; reversal and six momentum variants', async () => {
  const L = await learned();
  const f = forwardResults(L.app.db, L.scoring);
  assert.equal(f.length, 7);
  assert.deepEqual(f.map(x => x.id), ['rev5s', 'mom63s', 'mom63', 'mom126s', 'mom126', 'mom252s', 'mom252']);
  const all = L.app.db.stmt("SELECT o.excess AS e FROM candidate c JOIN candidate_outcome o ON o.candidate_id = c.candidate_id WHERE c.scoring_build = ? AND o.status = 'ok'").all(MOM_BUILD).map(r => r.e);
  const m63 = f.find(x => x.id === 'mom63');
  assert.equal(m63.days, 1); assert.equal(m63.names, 6, 'all six names are inside every top 20');
  assert.ok(Math.abs(m63.meanGross - all.reduce((s, x) => s + x, 0) / all.length) < 1e-12);
  assert.ok(Math.abs(m63.meanNet10 - (m63.meanGross - 0.001)) < 1e-12);
  assert.deepEqual(m63.series.map(p => p[0]), [D]);
  const rev = f.find(x => x.id === 'rev5s');
  assert.equal(rev.build, SCORING_BUILD); assert.ok(rev.days >= 0);
  const none = forwardResults((await makeLearning({ members: SYMS })).app.db, L.scoring);
  assert.ok(none.every(x => x.days === 0 && x.meanGross === null && x.series.length === 0), 'no outcomes: no numbers, never a guess');
  await L.app.stop();
});

test('state: one object with every part; a part whose table is missing reports its own error and the rest still render', async () => {
  const L = await learned();
  const api = { runs: { health: () => ({ summary: 'data layer: ok', targetSession: D, coverage: { fresh: 5, of: 6 }, dataAgeMs: 1000 }) }, spreads: { summary: () => ({ samples: 0 }) }, shadow: L.shadow, scoring: L.scoring, calibration: L.calibration };
  const s = buildState({ app: L.app, api, config: { paperTrading: { enabled: false }, broker: { enabled: false, maxNotionalUsd: 1000 } }, now: () => Date.parse('2026-11-17T16:00:00Z') });
  assert.equal(s.nyDay, '2026-11-17'); assert.equal(s.marketOpen, true);
  assert.equal(s.engine.started, true); assert.ok(s.engine.features.includes('shadow'));
  assert.equal(s.data.coverage.fresh, 5);
  assert.equal(s.shadow.momentum.build, MOM_BUILD); assert.equal(s.shadow.reversal.days, 1);
  assert.equal(s.forward.length, 7);
  assert.ok(s.spreads.error, 'this database has no spread table: that part says so');
  assert.ok(typeof s.summaries.shadow === 'string' && /momentum/.test(s.summaries.shadow));
  assert.deepEqual(s.switches, { paperTrading: false, brokerOrders: false, brokerMaxNotionalUsd: 1000 });
  assert.match(s.note, /never predictions/);
  JSON.stringify(s);   // plain data
  await L.app.stop();
});

function get(port, p, headers = {}) {
  return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p, headers }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej); });
}
const freePort = () => new Promise(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('bridge: the page, its script and style, and the numbers are served same-origin only, with a strict content security policy; an engine error is data, not a hang', async () => {
  const p = await freePort();
  let fail = false;
  const kit = Buffer.from('/* kit */');
  const br = await startBridge({
    bus: createBus(), version: '1', ports: [p],
    dashboard: { query: () => ({}), files: { html: Buffer.from(''), js: Buffer.from(''), css: Buffer.from(''), hudCss: kit, hudJs: kit, palette: kit } },
    stockman: { state: async () => { if (fail) throw Object.assign(new Error('the engine is still starting'), { code: 'TRANSIENT' }); return { engine: { started: true } }; }, files: { html: Buffer.from('<html>sm</html>'), js: Buffer.from('//js'), css: Buffer.from('/*css*/') } },
  });
  try {
    const page = await get(br.port, '/ai/stockman');
    assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.equal(page.body, '<html>sm</html>');
    assert.match(page.headers['content-security-policy'], /script-src 'self'/); assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(br.port, '/ai/stockman.js')).headers['content-type'].startsWith('text/javascript'), true);
    assert.equal((await get(br.port, '/ai/stockman.css')).status, 200);
    const st = await get(br.port, '/ai/stockman/state');
    assert.equal(st.status, 200); assert.deepEqual(JSON.parse(st.body), { engine: { started: true } }); assert.equal(st.headers['cache-control'], 'no-store');
    assert.equal((await get(br.port, '/ai/stockman/state', { Origin: 'http://evil.example' })).status, 403, 'another page cannot read the numbers');
    assert.equal((await get(br.port, '/ai/stockman', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await get(br.port, '/ai/stockman/state', { Origin: `http://127.0.0.1:${br.port}` })).status, 200);
    fail = true;
    const down = await get(br.port, '/ai/stockman/state');
    assert.equal(down.status, 503); assert.equal(JSON.parse(down.body).code, 'TRANSIENT');
  } finally { await br.close(); }
  const p2 = await freePort();
  const off = await startBridge({ bus: createBus(), version: '1'
 });
  try { assert.equal((await get(off.port, '/ai/stockman')).status, 404, 'no engine, no page'); } finally { await off.close(); }
});

test('page: no inline script or style, no innerHTML, no network call but its own state route, and no order or write method anywhere', () => {
  const dir = path.join(__dirname, '../src/ui/stockman');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), js = fs.readFileSync(path.join(dir, 'stockman.js'), 'utf8'), css = fs.readFileSync(path.join(dir, 'stockman.css'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'no inline script'); assert.ok(!/\sstyle\s*=/i.test(html), 'no inline style attribute');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), 'text goes in as text');
  const urls = [...js.matchAll(/fetch\(\s*'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(urls, ['/ai/stockman/state']);
  assert.ok(!/method\s*:\s*'(POST|PUT|DELETE|PATCH)'/i.test(js), 'the page only reads');
  assert.ok(!/@import|url\(\s*http/i.test(css), 'no outside styles');
});
