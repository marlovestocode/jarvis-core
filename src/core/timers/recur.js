// Repeating alarms and reminders. A repeat is { kind: 'daily' | 'weekly' | 'monthly', days?: [0-6] (Sunday = 0), dom?: 1-31, at: 'HH:MM' }
// in local time. The next occurrence is always computed from "now", so a PC that was off for days fires once, not once per missed day.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const dayIndex = w => { const s = String(w).trim().toLowerCase().replace(/s$/, ''); const i = DAYS.indexOf(s); return i >= 0 ? i : (SHORT[s] ?? SHORT[s + 's'] ?? -1); };
const pad = n => String(n).padStart(2, '0');

// words → repeat, or null when the words are not a repeat. `due` (epoch ms) gives the clock time and, for weekly/monthly, the day.
function parseRepeat(text, due) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || !Number.isFinite(due)) return null;
  const d = new Date(due);
  const at = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (/^(?:daily|every ?day|each day|everyday)$/.test(t)) return { kind: 'daily', at };
  if (/^(?:weekdays?|every weekday|each weekday|work ?days?|monday (?:to|through|-) friday)$/.test(t)) return { kind: 'weekly', days: [1, 2, 3, 4, 5], at };
  if (/^(?:weekends?|every weekend|each weekend)$/.test(t)) return { kind: 'weekly', days: [0, 6], at };
  if (/^(?:weekly|every week|each week)$/.test(t)) return { kind: 'weekly', days: [d.getDay()], at };
  if (/^(?:monthly|every month|each month)$/.test(t)) return { kind: 'monthly', dom: d.getDate(), at };
  const list = t.replace(/^(?:every|each|on)\s+/, '').split(/\s*(?:,|and|&)\s*|\s+/).filter(Boolean).map(dayIndex);
  if (list.length && list.every(i => i >= 0)) return { kind: 'weekly', days: [...new Set(list)].sort(), at };
  return null;
}

const valid = r => r && typeof r === 'object' && ['daily', 'weekly', 'monthly'].includes(r.kind) && /^\d{2}:\d{2}$/.test(r.at || '')
  && (r.kind !== 'weekly' || (Array.isArray(r.days) && r.days.length && r.days.every(i => Number.isInteger(i) && i >= 0 && i <= 6)))
  && (r.kind !== 'monthly' || (Number.isInteger(r.dom) && r.dom >= 1 && r.dom <= 31));

// the first occurrence strictly after `after` (epoch ms)
function nextDue(rep, after) {
  if (!valid(rep)) return null;
  const [h, m] = rep.at.split(':').map(Number);
  const base = new Date(after);
  for (let i = 0; i <= 400; i++) {
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
    if (c.getTime() <= after) continue;
    if (rep.kind === 'weekly' && !rep.days.includes(c.getDay())) continue;
    if (rep.kind === 'monthly' && c.getDate() !== rep.dom) continue;
    return c.getTime();
  }
  return null;
}

function sayRepeat(rep) {
  if (!valid(rep)) return '';
  const [h, m] = rep.at.split(':').map(Number);
  const clock = `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  if (rep.kind === 'daily') return `every day at ${clock}`;
  if (rep.kind === 'monthly') return `on day ${rep.dom} of every month at ${clock}`;
  const key = [...rep.days].sort().join();
  if (key === '1,2,3,4,5') return `every weekday at ${clock}`;
  if (key === '0,6') return `every weekend at ${clock}`;
  return `every ${rep.days.map(i => DAYS[i].replace(/^./, c => c.toUpperCase())).join(', ')} at ${clock}`;
}

module.exports = { parseRepeat, nextDue, sayRepeat, validRepeat: valid };
