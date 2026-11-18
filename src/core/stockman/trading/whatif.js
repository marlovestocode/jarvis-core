'use strict';
// What-if exits (R6, vault D31): what a mid-trade exit WOULD have done to the paper opener's positions. It never acts.
//
// The pre-registered rules trade "entry next open, exit 5th close, no stops" (note 06) and that is not changed. This report replays each
// closed paper-internal position over its stored daily bars and asks, for four exit rules fixed in D31 before any result was seen:
//   stop5      exit at the first close at or below entry x 0.95
//   take5      exit at the first close at or above entry x 1.05
//   trail5     exit at the first close at or below 0.95 x the highest close since entry
//   rescore0   exit at the close of the first held day whose logged reversal score (shadow `candidate.score`) is below 0
// what the position would have returned (same cost as the actual close) against what it did. Computed on demand from the ledger, the
// bars and the shadow log, so there is no table and nothing to keep in step; the bars are adjusted closes (the opener's basis).
// The windows overlap and the rules were not tested before; the result is a description of past paper trades, not evidence of an edge.

const RULES = Object.freeze({
  stop5: { label: 'stop loss 5% (close)', kind: 'stop', pct: 5 },
  take5: { label: 'take profit 5% (close)', kind: 'take', pct: 5 },
  trail5: { label: 'trailing stop 5% from the highest close', kind: 'trail', pct: 5 },
  rescore0: { label: 're-score: logged reversal score below 0', kind: 'rescore', build: 'rev-v1.0' },
});
const LABEL = 'what-if only, never acted on; overlapping windows; not evidence of an edge';

function createWhatIf({ opts = {} } = {}) {
  const o = { source: 'paper-internal', ...opts };
  let db = null;

  function pathOf(p) {
    // adjusted closes from the entry day to the exit day; the entry fill is on the same adjusted basis (paper.js)
    return db.stmt('SELECT day, adj_close AS adj FROM bar WHERE symbol = ? AND day >= ? AND day <= ? AND adj_close > 0 ORDER BY day').all(p.symbol, p.entry_day, p.exit_day);
  }
  function scoreOn(symbol, day, build) {
    const r = db.stmt('SELECT score FROM candidate WHERE symbol = ? AND day = ? AND scoring_build = ?').get(symbol, day, build);
    return r && r.score !== null && r.score !== undefined ? Number(r.score) : null;
  }

  // the first day (before the planned exit day) a rule exits, with its close, or null
  function trigger(rule, p, bars) {
    const entry = p.fill_entry_price;
    let high = entry;
    for (const b of bars) {
      if (b.day >= p.exit_day) break;                 // the planned exit day is the actual exit
      high = Math.max(high, b.adj);
      if (rule.kind === 'stop' && b.adj <= entry * (1 - rule.pct / 100)) return b;
      if (rule.kind === 'take' && b.adj >= entry * (1 + rule.pct / 100)) return b;
      if (rule.kind === 'trail' && b.adj <= high * (1 - rule.pct / 100)) return b;
      if (rule.kind === 'rescore') { const s = scoreOn(p.symbol, b.day, rule.build); if (s !== null && s < 0) return b; }
    }
    return null;
  }

  function report({ limit = 5000 } = {}) {
    if (!db) return { label: LABEL, positions: 0, rules: {} };
    const ps = db.stmt(`SELECT * FROM paper_position WHERE source = ? AND status = 'closed' AND fill_entry_price > 0 AND net_return IS NOT NULL ORDER BY id DESC LIMIT ?`).all(o.source, Math.max(1, Math.min(100000, limit)));
    const rules = {};
    for (const [id, rule] of Object.entries(RULES)) rules[id] = { label: rule.label, n: 0, triggered: 0, actualMean: null, whatIfMean: null, diffMean: null, better: 0, worse: 0, examples: [] };
    let sumActual = 0;
    for (const p of ps) {
      const bars = pathOf(p), cost = (p.cost_bps || 0) / 1e4;
      sumActual += p.net_return;
      for (const [id, rule] of Object.entries(RULES)) {
        const R = rules[id], hit = trigger(rule, p, bars);
        const wi = hit ? hit.adj / p.fill_entry_price - 1 - cost : p.net_return;
        R.n++; R._a = (R._a || 0) + p.net_return; R._w = (R._w || 0) + wi;
        if (hit) {
          R.triggered++;
          if (wi > p.net_return + 1e-12) R.better++; else if (wi < p.net_return - 1e-12) R.worse++;
          if (R.examples.length < 5) R.examples.push({ positionId: p.id, symbol: p.symbol, exitDay: hit.day, whatIf: wi, actual: p.net_return });
        }
      }
    }
    for (const R of Object.values(rules)) {
      if (R.n) { R.actualMean = R._a / R.n; R.whatIfMean = R._w / R.n; R.diffMean = R.whatIfMean - R.actualMean; }
      delete R._a; delete R._w;
    }
    return { label: LABEL, source: o.source, positions: ps.length, actualMean: ps.length ? sumActual / ps.length : null, rules };
  }

  function health() {
    if (!db) return { summary: '' };
    const r = report();
    if (!r.positions) return { summary: `what-if exits (R6): no closed paper position yet (${LABEL})` };
    const pct = x => (x === null ? 'n/a' : (x * 100).toFixed(2) + '%');
    const parts = Object.entries(r.rules).map(([id, R]) => `${id} ${R.triggered}/${R.n} hit, mean ${pct(R.whatIfMean)} vs ${pct(R.actualMean)}`);
    return { summary: `what-if exits (R6): ${parts.join('; ')} (${LABEL})` };
  }

  const api = { report, RULES, LABEL };
  const feature = { id: 'whatif', async start(ctx) { db = ctx.db; }, async stop() { /* nothing runs on its own */ }, health };
  return { feature, api };
}

module.exports = { createWhatIf, RULES, LABEL };
