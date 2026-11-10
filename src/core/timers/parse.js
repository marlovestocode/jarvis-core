// Spoken times for timers, alarms and reminders. Deterministic, no model.
//   parseDuration("1 hour 30") → 5400000 ms, or null
//   parseWhen("at 7", now) → { at: epoch ms, ambiguous } (next occurrence; "at 7" has no am/pm → ambiguous), or null
//   sayTime(at, now) → "7:00 AM tomorrow"
// Targets are built from local wall-clock parts (new Date(y, m, d, h, min)) so DST nights land right;
// everything after that is absolute epoch ms.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const NUM_WORDS = new RegExp(`\\b(?:(${Object.keys(TENS).join('|')})(?:[\\s-](${ONES.slice(1, 10).join('|')}))?|(${ONES.join('|')}))\\b`, 'g');
const UNIT = '(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)';
const UNIT_MS = { h: 3600e3, m: 60e3, s: 1e3 };
const unitKey = u => (u.startsWith('h') ? 'h' : u.startsWith('m') ? 'm' : 's');

function norm(text) {
  return String(text ?? '').toLowerCase()
    .replace(/\ba\.m\.?/g, 'am').replace(/\bp\.m\.?/g, 'pm').replace(/o'?clock/g, '')
    .replace(NUM_WORDS, (_, tens, one, single) => String(tens ? TENS[tens] + (one ? ONES.indexOf(one) : 0) : ONES.indexOf(single)))
    .replace(/[,.!?]+$/g, '').replace(/\s+/g, ' ').trim();
}

function parseDuration(text) {
  let t = norm(text).replace(/^(?:in|for|after)\s+/, '');
  if (!t) return null;
  if (/^half (?:an? )?hour$/.test(t)) return 1800e3;
  t = t.replace(/\b(?:a|an)\s+(?=(?:hour|minute|second|min|sec)s?\b)/g, '1 ')
    .replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\s+and\\s+a\\s+half\\b`, 'g'), (_, n, u) => `${+n + 0.5} ${u}`);
  const piece = new RegExp(`^(?:and\\s+)?(\\d+(?:\\.\\d+)?)\\s*(?:${UNIT}\\b)?\\s*`);
  let total = 0, last = null, m;
  while (t && (m = piece.exec(t))) {
    const n = +m[1];
    let u = m[2] ? unitKey(m[2]) : null;
    t = t.slice(m[0].length);
    if (!u) {   // "1 hour 30": a bare number after hours is minutes, after minutes is seconds
      if (t || !last || last === 's') return null;
      u = last === 'h' ? 'm' : 's';
    }
    total += n * UNIT_MS[u];
    last = u;
  }
  if (t || !(total > 0)) return null;
  return Math.round(total);
}

// "tomorrow at 9", "thursday 9 am", "half past six", "noon" → { dayOffset?, weekday?, h, min, explicit, today? }
function readClock(t) {
  let s = t.replace(/^(?:at|for|on)\s+/, '');
  let day = null, tonight = false;
  s = s.replace(/\b(today|tonight|tomorrow)\b/, (_, d) => { day = d; if (d === 'tonight') tonight = true; return ''; })
    .replace(new RegExp(`\\b(?:next\\s+|on\\s+)?(${WEEKDAYS.join('|')})\\b`), (_, w) => { day = w; return ''; })
    .replace(/\b(?:at|on)\b/g, '').replace(/\s+/g, ' ').trim();
  let h, min = 0, delta = 0, ap = null, m;
  if (s === 'noon' || s === 'midday') { h = 12; ap = 'pm'; }
  else if (s === 'midnight') { h = 12; ap = 'am'; }
  else if ((m = /^(half past|quarter past|quarter to)\s+(\d{1,2})(?:\s*(am|pm))?$/.exec(s))) {
    h = +m[2]; ap = m[3] || null;
    delta = { 'half past': 30, 'quarter past': 15, 'quarter to': -15 }[m[1]];
  } else if ((m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s))) {
    h = +m[1]; min = m[2] ? +m[2] : 0; ap = m[3] || null;
  } else return null;
  if (min > 59) return null;
  if (ap ? h < 1 || h > 12 : h > 23) return null;
  if (!ap && tonight && h >= 1 && h <= 11) ap = 'pm';
  let hours;
  if (ap) hours = [(h % 12) + (ap === 'pm' ? 12 : 0)];
  else if (h === 0 || h > 12) hours = [h];
  else hours = [h % 12, (h % 12) + 12].sort((a, b) => a - b);   // no am/pm: both, earliest first
  return { day, hours, min, delta, ambiguous: hours.length > 1 };
}

function parseWhen(text, now = Date.now()) {
  const raw = String(text ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/i.test(raw)) {
    const t = Date.parse(raw.replace(' ', 'T'));   // date-time without zone = local
    return Number.isNaN(t) ? null : { at: t, ambiguous: false };
  }
  const t = norm(raw);
  if (/^in\s/.test(t)) {
    const d = parseDuration(t);
    return d ? { at: now + d, ambiguous: false } : null;
  }
  const c = readClock(t);
  if (!c) return null;
  const n = new Date(now);
  let offsets;
  if (!c.day || c.day === 'today' || c.day === 'tonight') offsets = c.day ? [0] : [0, 1];
  else if (c.day === 'tomorrow') offsets = [1];
  else { const w = WEEKDAYS.indexOf(c.day); const k = (w - n.getDay() + 7) % 7; offsets = [k, k + 7]; }
  for (const off of offsets) {
    for (const h of c.hours) {
      const at = new Date(n.getFullYear(), n.getMonth(), n.getDate() + off, h, c.min + c.delta).getTime();
      if (at > now) return { at, ambiguous: c.ambiguous };
    }
  }
  return null;   // "today at 7 am" when that has passed
}

function sayTime(at, now = Date.now()) {
  const d = new Date(at), n = new Date(now);
  const h = d.getHours() % 12 || 12;
  const clock = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5);
  const wd = WEEKDAYS[d.getDay()].replace(/^./, c => c.toUpperCase());
  if (days === 0) return `${clock} today`;
  if (days === 1) return `${clock} tomorrow`;
  if (days > 1 && days < 7) return `${clock} on ${wd}`;
  return `${clock} on ${wd}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

module.exports = { parseDuration, parseWhen, sayTime };
