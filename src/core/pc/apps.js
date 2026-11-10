// Which apps JARVIS may open: the Start menu's own list plus the user's `pc.apps` map from settings.
// A spoken name is matched against that list only; free text is never run.
//   buildAllowlist(startApps, userApps) → [{ name, target, source: 'user'|'start' }]
//   resolveApp(spoken, list) → { entry } | { ambiguous: [entry] } | null
const { matchText, norm } = require('../media/rank');

const MIN_SCORE = 0.6;
const TIE = 0.05;              // best and runner-up this close → ask which
const EXTRA_TOKEN = 0.02;      // "chrome" prefers "Google Chrome" over "Chrome Remote Desktop"

// a user-map target: an absolute .exe/.lnk path, or a Start menu AppID (Package!App)
function validAppTarget(t) {
  if (typeof t !== 'string' || !t || t.length > 400 || /[\r\n\0"<>|&;^%`$]/.test(t)) return false;
  if (/^[a-z]:\\[^:*?]+\.(?:exe|lnk)$/i.test(t)) return true;
  return /^[\w.-]+_[a-z0-9]{13}![\w.-]+$/i.test(t);
}

function buildAllowlist(startApps = [], userApps = {}) {
  const user = Object.entries(userApps || {})
    .filter(([name, target]) => typeof name === 'string' && name.trim() && validAppTarget(target))
    .map(([name, target]) => ({ name: name.trim(), target, source: 'user' }));
  const start = (startApps || []).filter(a => a && a.name && a.appId).map(a => ({ name: a.name, target: a.appId, source: 'start' }));
  return [...user, ...start];
}

const spokenName = s => norm(s).replace(/^(?:the|my)\s+/, '').replace(/\s+(?:app|application|program)$/, '').trim();

function resolveApp(spoken, list) {
  const q = spokenName(spoken);
  if (!q) return null;
  const exact = list.filter(e => norm(e.name) === q);
  if (exact.length) return { entry: exact.find(e => e.source === 'user') || exact[0] };
  const qn = q.split(' ').length;
  const scored = list.map(e => {
    const raw = matchText(q, e.name);
    return { e, raw, s: raw - EXTRA_TOKEN * Math.max(0, norm(e.name).split(' ').length - qn) };
  }).filter(x => x.raw >= MIN_SCORE).sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  const close = scored.filter(x => scored[0].s - x.s < TIE);
  if (close.length > 1) return { ambiguous: close.slice(0, 4).map(x => x.e) };
  return { entry: scored[0].e };
}

module.exports = { buildAllowlist, resolveApp, validAppTarget };
