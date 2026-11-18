// Threat rules over the model consensus, NWS alerts, a pressure trend and radar cells → { level, kind, etaHours, reasons }.
// Pure: numbers in, a level out. Reasons are built from numbers and NWS event names (clipped), never from alert headlines or descriptions.
const { clip } = require('../proactive/monitors/clip');

const LEVELS = Object.freeze(['none', 'watch', 'warning', 'severe', 'extreme']);
const lv = n => LEVELS[Math.max(0, Math.min(4, n))];
const agree = (vals, pred) => ({ k: vals.filter(pred).length, n: vals.length });

function assessThreat({ hours = [], alerts = [], pressureTrend = null, radar = null } = {}) {
  const found = [];   // { level (index into LEVELS), kind, eta (hours), reason }
  const add = (level, kind, eta, reason) => found.push({ level, kind, eta, reason });

  for (const a of alerts) {
    const ev = clip(a?.event);
    if (!ev) continue;
    if (a.severity === 'Extreme') add(4, 'alert', 0, `NWS ${ev} (extreme)`);
    else if (a.severity === 'Severe') add(3, 'alert', 0, `NWS ${ev} (severe)`);
  }

  // models agreeing, not one model's opinion; the earliest hour of the strongest agreement is the ETA
  const best = {};
  const keep = (kind, level, eta, reason) => { if (!best[kind] || level > best[kind].level) best[kind] = { level, eta, reason }; };
  hours.forEach((h, i) => {
    const g = agree(h.gust?.values || [], v => v >= 58);
    const g2 = agree(h.gust?.values || [], v => v >= 45);
    if (g.k >= 2 && g.k / g.n >= 0.5) keep('wind', 3, i, `${g.k} of ${g.n} models forecast gusts of 58 mph or more`);
    else if (g.k >= 2 && g.k / g.n >= 1 / 3) keep('wind', 2, i, `${g.k} of ${g.n} models forecast gusts of 58 mph or more`);
    else if (g2.k >= 2 && g2.k / g2.n >= 0.5) keep('wind', 1, i, `${g2.k} of ${g2.n} models forecast gusts of 45 mph or more`);

    // heavy rain: 1 in/h, or 2 in over 3 h (model j's hours i..i+2)
    const now = h.precip?.values || [];
    const three = [0, 1, 2].map(d => hours[i + d]?.precip?.values || []);
    const k = Math.max(agree(now, v => v >= 1).k, agree(now.map((_, j) => three.reduce((s, t) => s + (t[j] || 0), 0)), v => v >= 2).k);
    if (k >= 2 && k / now.length >= 0.5) keep('flood', 2, i, `${k} of ${now.length} models forecast heavy rain (1 in/h or 2 in in 3 h)`);
    else if (k >= 2 && k / now.length >= 1 / 3) keep('flood', 1, i, `${k} of ${now.length} models forecast heavy rain (1 in/h or 2 in in 3 h)`);

    // thunderstorms with unstable air (CAPE) agreed on by models
    const cape = h.cape?.values || [], code = h.code?.values || [];
    const hi = cape.filter((c, j) => c >= 2000 && code[j] >= 95), big = cape.filter((c, j) => c >= 3000 && code[j] >= 95);
    if (big.length >= 2 && big.length / cape.length >= 0.5) keep('storm', 2, i, `${big.length} of ${cape.length} models forecast thunderstorms with very high instability (CAPE 3000+)`);
    else if (hi.length >= 2 && hi.length / cape.length >= 1 / 3) keep('storm', 1, i, `${hi.length} of ${cape.length} models forecast thunderstorms with high instability (CAPE 2000+)`);
  });
  for (const [kind, b] of Object.entries(best)) add(b.level, kind, b.eta, b.reason);

  // radar cells heading for home
  for (const c of radar?.cells || []) {
    if (!(c.approachKmh > 0) || !(c.distKm >= 0) || !(c.dbz >= 45)) continue;
    const eta = c.distKm / c.approachKmh;
    if (eta <= 0.75) add(c.dbz >= 55 && eta <= 0.5 ? 2 : 1, 'storm', eta, `radar: a ${Math.round(c.dbz)} dBZ cell ${Math.round(c.distKm)} km away closing at ${Math.round(c.approachKmh)} km/h`);
  }

  found.sort((a, b) => b.level - a.level);
  const top = found[0] || null;
  const reasons = found.map(f => f.reason);
  let level = top ? top.level : 0;
  if (Number.isFinite(pressureTrend?.hPaPer3h) && pressureTrend.hPaPer3h <= -6) {
    reasons.push(`pressure falling fast (${Math.abs(Math.round(pressureTrend.hPaPer3h))} hPa in 3 h)`);
    if (level > 0 && level < 3) level += 1;
  }
  return { level: lv(level), kind: top ? top.kind : null, etaHours: top ? +top.eta.toFixed(2) : null, reasons };
}

module.exports = { assessThreat, LEVELS };
