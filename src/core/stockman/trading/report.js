// Plain-text summary of a backtest result (what the CLI prints). The variant count and the caveats are always part of it.
const pct = (x, digits = 3) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : 'n/a');

function formatResult(r) {
  const s = r.summary, g = r.survivorship, L = [];
  L.push(`BACKTEST ${r.variant}  (${r.buildId})  period: ${r.period.toUpperCase()}   run ${r.runId}`);
  L.push(`Variants tried so far: ${r.variantsTried} of ${r.variantsAllowed} allowed. Every result below must be read with that count beside it.`);
  L.push(`Signals ${r.firstSignalDay} to ${r.lastSignalDay}; trades ${r.firstEntryDay} to ${r.lastExitDay}. Trading days run ${r.tradingDaysRun}, skipped ${r.skippedDays}.`);
  L.push(`Baskets: ${s.baskets} (all five sleeves). Non-overlapping 5-session windows used for the statistics: ${s.windows}.`);
  L.push(`Per window, top-20 equal weight, entry next open, exit 5th close, versus SPY over the same dates:`);
  L.push(`  mean gross return ${pct(s.grossMean)}   SPY mean ${pct(s.benchmarkMean)}   mean gross excess ${pct(s.grossExcessMean)}`);
  L.push(`  round-trip cost   mean excess after cost   95% interval (block bootstrap by window)   win rate   lower bound > 0?`);
  for (const bps of Object.keys(s.levels).map(Number)) {
    const v = s.levels[bps];
    L.push(`  ${String(bps).padStart(3)} bps${bps === s.baseBps ? ' (base)' : bps === 25 ? ' (stress)' : '       '}      ${pct(v.meanExcess).padStart(9)}              [${pct(v.lower95)}, ${pct(v.upper95)}]            ${pct(v.winRate, 1).padStart(6)}      ${v.lowerBoundAboveZero ? 'yes' : 'NO'}   (all-sleeve mean ${pct(v.allSleevesMeanExcess)})`);
  }
  L.push(`Brier skill: not computed (this rule produces a ranking, not probabilities).`);
  const ex = r.totals.excludedBy;
  L.push(`Exclusions (name-days): ${Object.entries(ex).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; earnings data unknown for ${r.totals.earningsUnknown} picked names; ${r.totals.lostNames} picked names lost for a missing entry or exit bar.`);
  L.push('');
  L.push(`SURVIVORSHIP GAP (vault G24): point-in-time members with NO bars at all, per signal day: average ${g.avgNoBars.toFixed(1)} (${pct(g.shareNoBars, 1)} of members), worst day ${g.maxNoBars}.`);
  L.push(`  Plus ${g.avgNoBarOnDay.toFixed(1)} members per day that have bars on other days but none on the signal day (listed later, renamed, or a data hole): excluded, not filled.`);
  for (const [y, t] of Object.entries(g.years)) L.push(`  ${y}: ${t.avgNoBars.toFixed(1)} of ${t.avgMembers.toFixed(0)} members missing on average (${pct(t.shareNoBars, 1)}), worst day ${t.maxNoBars}`);
  L.push(`  Per-day rows are in table backtest_day. Delisted or renamed names (failed banks, buyouts) have no bars, and a reversal rule buys big recent losers, so the missing names`);
  L.push(`  are likely the ones that kept falling: this result probably looks BETTER than a complete data set would show. It is biased in the rule's favour, by an unknown amount.`);
  L.push('');
  L.push(`Data: ${r.data.sessions} sessions ${r.data.firstSession} to ${r.data.lastSession}, ${r.data.symbolsWithBars} symbols with bars. Costs: ${r.baseBps} bps base is an assumption, not measured.`);
  L.push(r.period === 'tuning' ? 'Tuning period only. The holdout was not touched.' : 'HOLDOUT run: recorded; this variant can never be run on the holdout again.');
  L.push(r.caveat);
  return L.join('\n');
}

module.exports = { formatResult };
