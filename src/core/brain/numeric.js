// Numeric calculus on expressions: real roots, definite integrals (incl. infinite
// bounds), derivatives. Built on the safe expression engine.
const { compile, evaluate } = require('./expr');

function bound(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, '');
  if (['inf', '+inf', 'infinity', '+infinity', '∞', '+∞'].includes(s)) return Infinity;
  if (['-inf', '-infinity', '-∞'].includes(s)) return -Infinity;
  return evaluate(String(v)).value;
}

function fn(expr, variable) {
  const c = compile(expr);
  const v = variable || (c.vars.length === 1 ? c.vars[0] : 'x');
  const extra = c.vars.filter(n => n !== v);
  if (extra.length) throw new Error(`Unknown name "${extra[0]}" (only ${v} may vary)`);
  return { f: x => c.eval({ [v]: x }), variable: v };
}

// ---- roots: scan for sign changes, then bisect to full precision ----
function solve(equation, { variable, from = -100, to = 100, steps = 4000 } = {}) {
  const parts = String(equation).split('=');
  if (parts.length > 2) throw new Error('Use one "=" in the equation');
  const expr = parts.length === 2 ? `(${parts[0]}) - (${parts[1]})` : parts[0];
  const { f, variable: v } = fn(expr, variable);
  const a = bound(from), b = bound(to);
  if (!(Number.isFinite(a) && Number.isFinite(b) && a < b)) throw new Error('Search range must be finite with from < to');
  const roots = [];
  const add = r => { if (!roots.some(x => Math.abs(x - r) <= 1e-9 * Math.max(1, Math.abs(r)))) roots.push(r); };
  let x0 = a, y0 = f(a);
  if (y0 === 0) add(a);
  for (let i = 1; i <= steps && roots.length < 20; i++) {
    const x1 = a + (b - a) * i / steps;
    const y1 = f(x1);
    if (y1 === 0) add(x1);
    else if (Number.isFinite(y0) && Number.isFinite(y1) && y0 !== 0 && Math.sign(y0) !== Math.sign(y1)) {
      let lo = x0, hi = x1, flo = y0;
      for (let k = 0; k < 200 && hi - lo > 0; k++) {
        const mid = (lo + hi) / 2;
        if (mid === lo || mid === hi) break;
        const fm = f(mid);
        if (fm === 0) { lo = hi = mid; break; }
        if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
      }
      const r = (lo + hi) / 2;
      // a sign change across a pole (e.g. 1/x) is not a root
      if (Math.abs(f(r)) < 1e-6 * Math.max(1, Math.abs(y0), Math.abs(y1)) || Math.abs(f(r)) < 1e-9) add(r);
    }
    x0 = x1; y0 = y1;
  }
  roots.sort((p, q) => p - q);
  return { variable: v, roots, range: [a, b] };
}

// ---- integrals: adaptive Simpson; infinite bounds mapped onto finite ones ----
function simpson(g, a, b, eps, whole, fa, fm, fb, depth) {
  const m = (a + b) / 2, lm = (a + m) / 2, rm = (m + b) / 2;
  const flm = g(lm), frm = g(rm);
  const left = (m - a) / 6 * (fa + 4 * flm + fm), right = (b - m) / 6 * (fm + 4 * frm + fb);
  const diff = left + right - whole;
  if (depth <= 0 || Math.abs(diff) <= 15 * eps) return left + right + diff / 15;
  return simpson(g, a, m, eps / 2, left, fa, flm, fm, depth - 1) + simpson(g, m, b, eps / 2, right, fm, frm, fb, depth - 1);
}
function adaptive(g, a, b, eps = 1e-11) {
  const safe = x => { const y = g(x); return Number.isFinite(y) ? y : 0; };
  const fa = safe(a), fb = safe(b), fm = safe((a + b) / 2);
  return simpson(safe, a, b, eps, (b - a) / 6 * (fa + 4 * fm + fb), fa, fm, fb, 48);
}

function integrate(expr, { variable, from, to } = {}) {
  const { f, variable: v } = fn(expr, variable);
  let a = bound(from), b = bound(to), sign = 1;
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('Bad bounds');
  if (a === b) return { variable: v, value: 0 };
  if (a > b) { [a, b] = [b, a]; sign = -1; }
  const E = 1e-12;
  let value;
  if (Number.isFinite(a) && Number.isFinite(b)) value = adaptive(f, a, b);
  else if (Number.isFinite(a)) value = adaptive(t => f(a + t / (1 - t)) / ((1 - t) ** 2), 0, 1 - E);
  else if (Number.isFinite(b)) value = adaptive(t => f(b - t / (1 - t)) / ((1 - t) ** 2), 0, 1 - E);
  else value = adaptive(t => f(t / (1 - t * t)) * (1 + t * t) / ((1 - t * t) ** 2), -1 + E, 1 - E);
  if (!Number.isFinite(value)) throw new Error('Integral did not converge');
  return { variable: v, value: sign * value };
}

// ---- derivatives: central differences with Richardson extrapolation ----
function differentiate(expr, { variable, at, order = 1 } = {}) {
  const { f, variable: v } = fn(expr, variable);
  const x = bound(at);
  if (!Number.isFinite(x)) throw new Error('Give a finite point "at"');
  const h = 1e-3 * Math.max(1, Math.abs(x));
  const d1 = s => (f(x + s) - f(x - s)) / (2 * s);
  const d2 = s => (f(x + s) - 2 * f(x) + f(x - s)) / (s * s);
  const d = order === 2 ? d2 : d1;
  const value = (4 * d(h / 2) - d(h)) / 3; // Richardson: error O(h^4)
  return { variable: v, value, order };
}

module.exports = { solve, integrate, differentiate, bound };
