// US equity market calendar (NYSE and Nasdaq regular sessions): trading days, holidays, early closes, session times in New York time.
// Pure functions, no network, no database. The rules below are written from the published NYSE holiday rules as I know them
// (vault note 04 G10); they were NOT checked against an official calendar in this session (NYSE's own site is not an allowed host).
// The safety net is the cross-check in runs.js: a day this file calls open on which almost no symbol has a bar, or a day it calls closed
// on which symbols do have bars, is flagged in the data_quality summary instead of being trusted. Unscheduled closures cannot be known in advance.
//
// Rules (RULES_VERSION 1), regular hours 09:30 to 16:00 New York; early close 13:00:
//   closed: weekends; New Year's Day (Saturday: no holiday on the Friday before; Sunday: Monday); Martin Luther King Jr. Day (3rd Monday of January);
//   Washington's Birthday (3rd Monday of February); Good Friday; Memorial Day (last Monday of May); Juneteenth (from 2022; weekend: nearest weekday);
//   Independence Day; Labor Day (1st Monday of September); Thanksgiving (4th Thursday of November); Christmas (weekend: nearest weekday).
//   early close: the Friday after Thanksgiving; July 3 and December 24 when they fall Monday to Thursday and are not holidays.
//   special closures listed in SPECIAL_CLOSURES (known one-offs only).
const { parseDate, fmtDate, addDays, dayOfWeek, nyDate, nyWallToMs } = require('./ny-time');

const RULES_VERSION = 1;
const SPECIAL_CLOSURES = Object.freeze({ '2025-01-09': 'National Day of Mourning (President Carter)' });
const OPEN = '09:30', CLOSE = '16:00', EARLY_CLOSE = '13:00';

const pad = n => String(n).padStart(2, '0');
// nth (1-based) weekday (0 = Sunday) of a month (1-12); n = -1 means the last one
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = dayOfWeek(`${year}-${pad(month)}-01`);
    return `${year}-${pad(month)}-${pad(1 + ((weekday - first + 7) % 7) + (n - 1) * 7)}`;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${pad(month)}-${pad(lastDay)}`;
  return addDays(last, -((dayOfWeek(last) - weekday + 7) % 7));
}
// Easter Sunday, Gregorian computus
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}
// a holiday on a Saturday is observed on the Friday, on a Sunday on the Monday
function observed(d) { const w = dayOfWeek(d); return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, 1) : d; }

const cache = new Map();
function holidays(year) {
  if (cache.has(year)) return cache.get(year);
  const h = new Map();
  const set = (d, name) => h.set(d, name);
  const jan1 = `${year}-01-01`;
  if (dayOfWeek(jan1) !== 6) set(observed(jan1), "New Year's Day");   // a Saturday New Year is not observed on the Friday before
  set(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  set(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  set(addDays(easter(year), -2), 'Good Friday');
  set(nthWeekday(year, 5, 1, -1), 'Memorial Day');
  if (year >= 2022) set(observed(`${year}-06-19`), 'Juneteenth');
  set(observed(`${year}-07-04`), 'Independence Day');
  set(nthWeekday(year, 9, 1, 1), 'Labor Day');
  set(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  set(observed(`${year}-12-25`), 'Christmas Day');
  cache.set(year, h);
  return h;
}

// dayInfo('2026-11-27') → { day, kind: 'open' | 'early' | 'closed', open, close, reason }  (open/close are "HH:MM" New York time, null when closed)
function dayInfo(day) {
  parseDate(day);
  const w = dayOfWeek(day);
  if (w === 0 || w === 6) return { day, kind: 'closed', open: null, close: null, reason: 'weekend' };
  if (SPECIAL_CLOSURES[day]) return { day, kind: 'closed', open: null, close: null, reason: SPECIAL_CLOSURES[day] };
  const year = Number(day.slice(0, 4));
  const hol = holidays(year).get(day);
  if (hol) return { day, kind: 'closed', open: null, close: null, reason: hol };
  const thanks = nthWeekday(year, 11, 4, 4);
  if (day === addDays(thanks, 1)) return { day, kind: 'early', open: OPEN, close: EARLY_CLOSE, reason: 'day after Thanksgiving' };
  if ((day === `${year}-07-03` || day === `${year}-12-24`) && w >= 1 && w <= 4) return { day, kind: 'early', open: OPEN, close: EARLY_CLOSE, reason: day.endsWith('07-03') ? 'day before Independence Day' : 'Christmas Eve' };
  return { day, kind: 'open', open: OPEN, close: CLOSE, reason: null };
}

const isTradingDay = day => dayInfo(day).kind !== 'closed';
function tradingDays(from, to) {
  const out = [];
  for (let d = from; parseDate(d) <= parseDate(to); d = addDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}
const prevTradingDay = day => { let d = addDays(day, -1); while (!isTradingDay(d)) d = addDays(d, -1); return d; };
const nextTradingDay = day => { let d = addDays(day, 1); while (!isTradingDay(d)) d = addDays(d, 1); return d; };
const sessionCloseMs = day => { const i = dayInfo(day); return i.close ? nyWallToMs(day, i.close) : null; };

// The newest trading day whose session is finished and whose daily bar should be final. `bufferMin` waits a while after the bell
// (default 30 min) because the provider's daily bar is not trusted the second the session ends; its settle time is unmeasured.
function lastCompletedSession(nowMs, bufferMin = 30) {
  const today = nyDate(nowMs);
  const close = sessionCloseMs(today);
  if (close !== null && nowMs >= close + bufferMin * 60000) return today;
  return prevTradingDay(today);
}
// is the regular session in progress right now (New York time)?
function marketOpenNow(nowMs) {
  const today = nyDate(nowMs), i = dayInfo(today);
  return i.kind !== 'closed' && nowMs >= nyWallToMs(today, i.open) && nowMs < nyWallToMs(today, i.close);
}

module.exports = { RULES_VERSION, SPECIAL_CLOSURES, dayInfo, isTradingDay, tradingDays, prevTradingDay, nextTradingDay, sessionCloseMs, lastCompletedSession, marketOpenNow, holidays, easter, nthWeekday };
