// Calendar math in whole days (UTC dates, no time-of-day drift).
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readDate(s) {
  if (s === undefined || s === null || s === '' || s === 'today') {
    const n = new Date();
    return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const t = Date.parse(String(s));
  if (Number.isNaN(t)) throw new Error(`Cannot read date "${s}" (use YYYY-MM-DD)`);
  const d = new Date(t);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

const iso = t => new Date(t).toISOString().slice(0, 10);

function addTo(t, amount) {
  const m = /^\s*([-+]?\d+)\s*(day|week|month|year)s?\s*$/i.exec(String(amount));
  if (!m) throw new Error('Use an amount like "10 days", "-2 weeks", "3 months", "1 year"');
  const n = +m[1], unit = m[2].toLowerCase(), d = new Date(t);
  if (unit === 'day') return t + n * 864e5;
  if (unit === 'week') return t + n * 7 * 864e5;
  const months = unit === 'year' ? 12 * n : n;
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + months, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();   // clamp Jan 31 + 1 month → Feb 28
  return Date.UTC(y, mo, Math.min(day, last));
}

function dateCalc({ from, to, add } = {}) {
  const a = readDate(from);
  const out = { from: iso(a), weekday: WEEKDAYS[new Date(a).getUTCDay()] };
  if (to !== undefined) {
    const b = readDate(to);
    out.to = iso(b);
    out.days = Math.round((b - a) / 864e5);
    out.weeks = +(out.days / 7).toFixed(2);
    out.toWeekday = WEEKDAYS[new Date(b).getUTCDay()];
  }
  if (add !== undefined) {
    const r = addTo(a, add);
    out.date = iso(r);
    out.dateWeekday = WEEKDAYS[new Date(r).getUTCDay()];
  }
  return out;
}

module.exports = { dateCalc };
