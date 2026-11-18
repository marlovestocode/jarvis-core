// Tracks how close each model's forecast for home came to what was observed, so better models count for more in the blend.
// predict(hour, {model: value}, variable) when a forecast is fetched; observe(hour, value, variable) when that hour has been measured.
// Variables: 'temp' (the default; °F) and 'pressure' (hPa). Each has a scale (a typical miss), so errors are comparable and a model
// is judged on all of them together. Persisted as a small JSON object (load/save are injected); a save with only temperature
// errors (the first version) still loads. Weights stay within 0.25..3 so one lucky run never silences a model.
const MAX_PENDING = 100, ALPHA = 0.2, MIN_W = 0.25, MAX_W = 3;
const SCALE = { temp: 3, pressure: 1 };
const pkey = (hour, v) => (v === 'temp' ? hour : `${hour}#${v}`);
const ekey = (model, v) => (v === 'temp' ? model : `${model}#${v}`);

function createSkillTracker({ load = () => null, save = () => {} } = {}) {
  let s = load();
  if (!s || typeof s !== 'object') s = {};
  s.pred = s.pred && typeof s.pred === 'object' ? s.pred : {};
  s.err = s.err && typeof s.err === 'object' ? s.err : {};
  const persist = () => { try { save(s); } catch { /* losing a score is harmless */ } };
  return {
    predict(hour, byModel, variable = 'temp') {
      if (!SCALE[variable]) return;
      s.pred[pkey(hour, variable)] = byModel;
      const keys = Object.keys(s.pred).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PENDING))) delete s.pred[k];
      persist();
    },
    observe(hour, value, variable = 'temp') {
      const k = pkey(hour, variable), p = s.pred[k];
      if (!p || !SCALE[variable] || !Number.isFinite(value)) return;
      for (const [m, v] of Object.entries(p)) {
        if (!Number.isFinite(v)) continue;
        const e = Math.abs(v - value), o = s.err[ekey(m, variable)];
        s.err[ekey(m, variable)] = o ? { ema: o.ema + ALPHA * (e - o.ema), n: o.n + 1 } : { ema: e, n: 1 };
      }
      delete s.pred[k];
      persist();
    },
    weights(models) {
      const score = m => {
        const norm = Object.keys(SCALE).filter(v => s.err[ekey(m, v)]).map(v => s.err[ekey(m, v)].ema / SCALE[v]);
        return norm.length ? norm.reduce((a, b) => a + b, 0) / norm.length : null;
      };
      const sc = Object.fromEntries(models.map(m => [m, score(m)]));
      const known = models.filter(m => sc[m] !== null);
      const ref = known.length ? known.reduce((a, m) => a + sc[m], 0) / known.length : 0;
      const w = {};
      for (const m of models) w[m] = sc[m] === null ? 1 : Math.min(MAX_W, Math.max(MIN_W, ref / Math.max(0.08, sc[m])));
      return w;
    },
  };
}

module.exports = { createSkillTracker };
