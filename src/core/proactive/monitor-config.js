'use strict';
// Opt-in proactive monitors: defaults, clamping and a patch helper. Pure, no I/O.
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampNumber = (n, min, max) => Math.round(Math.max(min, Math.min(max, n)));

const DEFAULT_MONITORS = Object.freeze({
  timersSoon: Object.freeze({ enabled: false, leadMin: 10 }),
  sysmon: Object.freeze({ enabled: false, cpu: 90, ram: 90, disk: 95, temp: 85 }),
});
const RANGES = { leadMin: [1, 120], cpu: [1, 100], ram: [1, 100], disk: [1, 100], temp: [30, 110] };

const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;

function cleanMonitors(raw) {
  const out = {};
  for (const [name, def] of Object.entries(DEFAULT_MONITORS)) {
    const src = isObj(raw) && isObj(raw[name]) ? raw[name] : {};
    out[name] = {};
    for (const [k, d] of Object.entries(def)) {
      const v = src[k];
      if (k === 'enabled') out[name][k] = typeof v === 'boolean' ? v : d;
      else out[name][k] = typeof v === 'number' && Number.isFinite(v) ? clampNumber(v, ...RANGES[k]) : d;
    }
  }
  return out;
}

function patchMonitors(current, patch) {
  const monitors = cleanMonitors(current);
  const errors = [];
  if (!isObj(patch)) return { monitors, errors };
  for (const name of Object.keys(DEFAULT_MONITORS)) {
    if (!isObj(patch[name])) continue;
    for (const k of Object.keys(DEFAULT_MONITORS[name])) {
      if (!(k in patch[name])) continue;
      if (k === 'enabled') { monitors[name][k] = !!patch[name][k]; continue; }
      const n = num(patch[name][k]);
      if (Number.isFinite(n)) monitors[name][k] = clampNumber(n, ...RANGES[k]);
      else errors.push(`Bad ${name}.${k}: expected a number`);
    }
  }
  return { monitors, errors };
}

module.exports = { DEFAULT_MONITORS, cleanMonitors, patchMonitors, clampNumber };
