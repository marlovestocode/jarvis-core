// Statistics for the backtest (vault note 06). Pure functions. Deterministic: the bootstrap uses a seeded generator, so a run repeats exactly.
// Samples are per NON-OVERLAPPING 5-session window, never per row: names on the same day move together, and sleeves overlap in time.
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function stdev(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// Moving-block bootstrap of the mean of a time-ordered series. Blocks of consecutive windows keep any leftover serial correlation.
// Returns the mean and the 2.5th / 97.5th percentiles of the resampled means (a two-sided 95% interval; `lower95` is its lower end).
function blockBootstrapMean(xs, { block = 4, reps = 5000, seed = 20261117 } = {}) {
  const n = xs.length;
  if (n < 2) return { n, mean: mean(xs), lower95: NaN, upper95: NaN, block: 0, reps: 0 };
  const b = Math.max(1, Math.min(block, n)), rnd = mulberry32(seed), means = new Float64Array(reps), nBlocks = Math.ceil(n / b);
  for (let r = 0; r < reps; r++) {
    let sum = 0, taken = 0;
    for (let k = 0; k < nBlocks; k++) {
      const start = Math.floor(rnd() * (n - b + 1));
      for (let j = 0; j < b && taken < n; j++, taken++) sum += xs[start + j];
    }
    means[r] = sum / n;
  }
  const sorted = Array.from(means).sort((x, y) => x - y);
  return { n, mean: mean(xs), lower95: quantile(sorted, 0.025), upper95: quantile(sorted, 0.975), block: b, reps };
}

// Brier skill score against the base rate: 1 - BS / BS_base. Only meaningful when probabilities are produced (this rule produces none).
function brierSkill(probs, outcomes) {
  const n = probs.length;
  if (!n || n !== outcomes.length) return NaN;
  const bs = probs.reduce((s, p, i) => s + (p - outcomes[i]) ** 2, 0) / n, base = mean(outcomes), bsBase = outcomes.reduce((s, o) => s + (base - o) ** 2, 0) / n;
  return bsBase === 0 ? NaN : 1 - bs / bsBase;
}

module.exports = { mean, stdev, quantile, blockBootstrapMean, brierSkill, mulberry32 };
