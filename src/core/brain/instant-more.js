// More requests the code answers exactly (see instant.js): unit conversions and calendar days. Each returns a reply string or null.
const { convert } = require('./units');
const { dateCalc } = require('./dates');

const NUM = String.raw`-?\d+(?:,\d{3})*(?:\.\d+)?`;
const UNIT = String.raw`[a-z°µ/²³^*· ]{1,24}?`;
const CONVERT_HEAD = /^(?:what(?:'s|’s| is)\s+|how much is\s+|convert\s+)?/i;
const A_TO_B = new RegExp(`^(${NUM})\\s*(${UNIT})\\s+(?:to|in|into|as)\\s+(${UNIT})$`, 'i');
const HOW_MANY = new RegExp(`^how many (${UNIT}) (?:are |is )?(?:there )?in (?:a |an |one |(${NUM})\\s*)?(${UNIT})$`, 'i');

function pretty(v) {
  if (!Number.isFinite(v)) return null;
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const s = Number(v.toPrecision(6));
  return String(s).includes('e') ? s.toExponential(4).replace(/\.?0+e/, 'e') : String(s);
}

function units(raw) {
  const t = raw.replace(CONVERT_HEAD, '').replace(/[?!.\s]+$/, '').trim();
  let value, from, to;
  let m = A_TO_B.exec(t);
  if (m) { value = Number(m[1].replace(/,/g, '')); from = m[2].trim(); to = m[3].trim(); }
  else if ((m = HOW_MANY.exec(t))) { value = m[2] ? Number(m[2].replace(/,/g, '')) : 1; to = m[1].trim(); from = m[3].trim(); }
  else return null;
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return null;
  try {
    const r = convert(value, from, to);
    const out = pretty(r.value);
    return out === null ? null : `${pretty(value)} ${r.from} is ${out} ${r.to}.`;
  } catch { return null; }
}

// calendar days
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NAMED = { christmas: [11, 25], 'christmas day': [11, 25], 'new year': [0, 1], "new year's": [0, 1], "new year's day": [0, 1], 'new years': [0, 1], 'new years day': [0, 1], halloween: [9, 31], "valentine's day": [1, 14], 'valentines day': [1, 14], 'independence day': [6, 4] };
const utc = (y, m, d) => Date.UTC(y, m, d);
const iso = t => new Date(t).toISOString().slice(0, 10);
const todayUtc = now => utc(now.getFullYear(), now.getMonth(), now.getDate());

// "december 25", "dec 25 2027", "2026-12-25", "christmas" → UTC midnight; a date with no year is the next one ("until") or the last one ("since")
function readDay(s, now, dir) {
  const t = String(s).trim().toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/g, '$1').replace(/,/g, '').replace(/^the /, '');
  const today = todayUtc(now);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return utc(+m[1], +m[2] - 1, +m[3]);
  let md = NAMED[t] || null, year = null;
  if (!md && (m = /^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/.exec(t))) {
    const mi = MONTHS.findIndex(x => x === m[1] || x.slice(0, 3) === m[1].slice(0, 3) && m[1].length >= 3 && x.startsWith(m[1]));
    if (mi >= 0) { md = [mi, +m[2]]; year = m[3] ? +m[3] : null; }
  }
  if (!md) return null;
  if (year) return utc(year, md[0], md[1]);
  let c = utc(now.getFullYear(), md[0], md[1]);
  if (dir === 'until' && c < today) c = utc(now.getFullYear() + 1, md[0], md[1]);
  if (dir === 'since' && c > today) c = utc(now.getFullYear() - 1, md[0], md[1]);
  return c;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const UNTIL = /^(?:how many days (?:are there |is it |are left )?(?:until|till|to|before)|days (?:until|till|to|before)|how long (?:until|till))\s+(.+)$/i;
const SINCE = /^(?:how many days (?:has it been |are there |ago was )?since|days since|how long since)\s+(.+)$/i;
const BETWEEN = /^(?:how many days (?:are there )?between|days between)\s+(.+?)\s+and\s+(.+)$/i;
const FROM_NOW = /^(?:what(?:'s|’s| is) the date|what date (?:is it|will it be)|what day (?:is it|will it be)|what(?:'s|’s| is) the date and day)\s+(?:in\s+)?(\d{1,4})\s+(day|week|month|year)s?(?:\s+from\s+(?:now|today))?$/i;

function days(raw, now, locale) {
  const t = raw.replace(/[?!.\s]+$/, '').trim();
  const today = todayUtc(now);
  let m;
  try {
    if ((m = UNTIL.exec(t))) {
      const to = readDay(m[1], now, 'until');
      if (to === null) return null;
      const d = Math.round((to - today) / 864e5);
      const label = new Date(to).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      return d === 0 ? `That is today, ${label}.` : d < 0 ? `${label} was ${plural(-d, 'day')} ago.` : `There ${d === 1 ? 'is' : 'are'} ${plural(d, 'day')} until ${label}.`;
    }
    if ((m = SINCE.exec(t))) {
      const from = readDay(m[1], now, 'since');
      if (from === null) return null;
      const d = Math.round((today - from) / 864e5);
      const label = new Date(from).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      return d < 0 ? `${label} is ${plural(-d, 'day')} away.` : `It has been ${plural(d, 'day')} since ${label}.`;
    }
    if ((m = BETWEEN.exec(t))) {
      const a = readDay(m[1], now, 'since'), b = readDay(m[2], now, 'until');
      if (a === null || b === null) return null;
      const r = dateCalc({ from: iso(a), to: iso(b) });
      return `There ${Math.abs(r.days) === 1 ? 'is' : 'are'} ${plural(Math.abs(r.days), 'day')} between ${iso(a)} and ${iso(b)}.`;
    }
    if ((m = FROM_NOW.exec(t))) {
      const r = dateCalc({ from: iso(today), add: `${m[1]} ${m[2].toLowerCase()}s` });
      const label = new Date(Date.parse(r.date)).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      return `It will be ${label}.`;
    }
  } catch { return null; }
  return null;
}

module.exports = { units, days };
