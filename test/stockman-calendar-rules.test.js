const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/core/stockman/features/ny-time');
const C = require('../src/core/stockman/features/calendar-rules');

const z = s => Date.parse(s);

test('ny-time: wall clock to instant across both daylight saving changes', () => {
  assert.equal(T.nyWallToMs('2026-11-16', '16:00'), z('2026-11-16T21:00:00Z'));   // EST
  assert.equal(T.nyWallToMs('2026-07-15', '16:00'), z('2026-07-15T20:00:00Z'));   // EDT
  assert.equal(T.nyWallToMs('2026-03-09', '09:30'), z('2026-03-09T13:30:00Z'));   // the day after spring forward: EDT
  assert.equal(T.nyWallToMs('2026-03-06', '09:30'), z('2026-03-06T14:30:00Z'));   // the Friday before: EST
  assert.equal(T.nyWallToMs('2026-11-02', '09:30'), z('2026-11-02T14:30:00Z'));   // the day after fall back: EST
  assert.equal(T.nyDate(z('2026-11-17T03:00:00Z')), '2026-11-16');                // 22:00 the evening before in New York
  assert.equal(T.nyDate(z('2026-07-15T03:59:00Z')), '2026-07-14');
  assert.equal(T.nyDate(z('2026-07-15T04:00:00Z')), '2026-07-15');
});

test('ny-time: date arithmetic and strict parsing', () => {
  assert.equal(T.addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(T.addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(T.dayOfWeek('2026-11-17'), 2);
  assert.equal(T.daysBetween('2026-11-10', '2026-11-17'), 7);
  assert.throws(() => T.parseDate('2026-02-30'), /not a real date/);
  assert.throws(() => T.parseDate('11/17/2026'), /YYYY-MM-DD/);
});

test('calendar: 2026 holidays, early closes and the weekend rule', () => {
  const closed = { '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday", '2026-04-03': 'Good Friday', '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independence Day', '2026-09-07': 'Labor Day', '2026-11-26': 'Thanksgiving Day', '2026-12-25': 'Christmas Day' };
  for (const [d, name] of Object.entries(closed)) { const i = C.dayInfo(d); assert.equal(i.kind, 'closed', d); assert.equal(i.reason, name, d); }
  assert.equal(C.dayInfo('2026-07-04').reason, 'weekend');   // Saturday: the holiday is observed on Friday the 3rd
  const early = C.dayInfo('2026-11-27');
  assert.deepEqual([early.kind, early.close], ['early', '13:00']);
  assert.equal(C.dayInfo('2026-12-24').kind, 'early');
  assert.equal(C.dayInfo('2026-07-02').kind, 'open');         // no early close when July 3 is the observed holiday
  assert.equal(C.dayInfo('2026-11-16').close, '16:00');
});

test('calendar: other years, observed rules and one-offs', () => {
  assert.equal(C.easter(2025), '2025-04-20');
  assert.equal(C.dayInfo('2025-04-18').reason, 'Good Friday');
  assert.equal(C.dayInfo('2027-07-05').reason, 'Independence Day');         // July 4 is a Sunday
  assert.equal(C.dayInfo('2027-12-24').reason, 'Christmas Day');            // December 25 is a Saturday: observed on the Friday
  assert.equal(C.dayInfo('2021-12-31').kind, 'open');                       // January 1 2022 is a Saturday: no holiday on the Friday before
  assert.equal(C.dayInfo('2022-06-20').reason, 'Juneteenth');               // first year, Sunday observed Monday
  assert.equal(C.dayInfo('2021-06-18').kind, 'open');                       // not a holiday before 2022
  assert.equal(C.dayInfo('2023-07-03').kind, 'early');
  assert.equal(C.dayInfo('2024-11-29').kind, 'early');
  assert.equal(C.dayInfo('2025-01-09').kind, 'closed');                     // national day of mourning
  assert.equal(C.dayInfo('2018-12-24').kind, 'early');
});

test('calendar: trading day lists skip weekends and holidays', () => {
  assert.deepEqual(C.tradingDays('2026-11-23', '2026-11-30'), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30']);
  assert.equal(C.prevTradingDay('2026-11-30'), '2026-11-27');
  assert.equal(C.nextTradingDay('2026-11-25'), '2026-11-27');
  assert.equal(C.prevTradingDay('2026-04-06'), '2026-04-02');               // over Good Friday and the weekend
});

test('calendar: the last completed session waits for the close plus a buffer', () => {
  assert.equal(C.lastCompletedSession(z('2026-11-17T21:00:00Z')), '2026-11-16');   // Tuesday 16:00: the bar is not trusted yet
  assert.equal(C.lastCompletedSession(z('2026-11-17T21:29:00Z')), '2026-11-16');
  assert.equal(C.lastCompletedSession(z('2026-11-17T21:30:00Z')), '2026-11-17');
  assert.equal(C.lastCompletedSession(z('2026-11-17T15:00:00Z')), '2026-11-16');   // mid-session
  assert.equal(C.lastCompletedSession(z('2026-11-21T15:00:00Z')), '2026-11-20');   // Saturday
  assert.equal(C.lastCompletedSession(z('2026-11-27T18:29:00Z')), '2026-11-25');   // early close day 13:00 = 18:00Z; 18:30 is the cutoff; Thursday is a holiday
  assert.equal(C.lastCompletedSession(z('2026-11-27T18:30:00Z')), '2026-11-27');
});

test('calendar: market open now', () => {
  assert.equal(C.marketOpenNow(z('2026-11-17T14:29:00Z')), false);
  assert.equal(C.marketOpenNow(z('2026-11-17T14:30:00Z')), true);
  assert.equal(C.marketOpenNow(z('2026-11-17T20:59:00Z')), true);
  assert.equal(C.marketOpenNow(z('2026-11-17T21:00:00Z')), false);
  assert.equal(C.marketOpenNow(z('2026-11-21T16:00:00Z')), false);
  assert.equal(C.marketOpenNow(z('2026-11-26T16:00:00Z')), false);
});
