// Descriptive statistics and least-squares line.
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function describeData(values) {
  const xs = (values || []).map(Number).filter(Number.isFinite);
  if (!xs.length) throw new Error('Give at least one number');
  const n = xs.length, s = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0), mean = sum / n;
  const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
  const top = Math.max(...counts.values());
  return {
    count: n, sum, mean, median: quantile(s, 0.5), min: s[0], max: s[n - 1], range: s[n - 1] - s[0],
    q1: quantile(s, 0.25), q3: quantile(s, 0.75),
    mode: top > 1 ? [...counts].filter(([, c]) => c === top).map(([v]) => v) : [],
    varianceSample: n > 1 ? ss / (n - 1) : 0, stdevSample: n > 1 ? Math.sqrt(ss / (n - 1)) : 0,
    variancePopulation: ss / n, stdevPopulation: Math.sqrt(ss / n),
  };
}

function regression(xs, ys) {
  if (!xs || !ys || xs.length !== ys.length || xs.length < 2) throw new Error('Give x and y lists of the same length (at least 2)');
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (sxx === 0) throw new Error('All x values are equal');
  const slope = sxy / sxx, intercept = my - slope * mx;
  return { slope, intercept, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy), r: syy === 0 ? 1 : sxy / Math.sqrt(sxx * syy) };
}

module.exports = { describeData, regression };
