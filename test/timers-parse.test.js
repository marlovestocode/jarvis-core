const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, parseWhen, sayTime } = require('../src/core/timers/parse');

const NOW = new Date(2026, 10, 10, 19, 30).getTime();   // Tue 10 Nov 2026, 7:30 PM local
const at = (y, m, d, h, mi) => new Date(y, m, d, h, mi).getTime();

test('timers parse: durations', () => {
  const rows = [
    ['10 minutes', 600e3], ['ten minutes', 600e3], ['1 hour 30', 5400e3], ['an hour and a half', 5400e3],
    ['90 seconds', 90e3], ['2h', 7200e3], ['half an hour', 1800e3], ['twenty five minutes', 1500e3],
    ['1 hour and 15 minutes', 4500e3], ['5 min', 300e3], ['banana', null], ['0 minutes', null], ['', null],
  ];
  for (const [text, ms] of rows) assert.equal(parseDuration(text), ms, text);
});

test('timers parse: clock times resolve to the next occurrence', () => {
  const rows = [
    ['7:30 am', [2026, 10, 11, 7, 30], false],
    ['at 7', [2026, 10, 11, 7, 0], true],
    ['at 9 pm', [2026, 10, 10, 21, 0], false],
    ['at half past six', [2026, 10, 11, 6, 30], true],
    ['tomorrow at 9', [2026, 10, 11, 9, 0], true],
    ['quarter to eight pm', [2026, 10, 10, 19, 45], false],
    ['quarter past 10 pm', [2026, 10, 10, 22, 15], false],
    ['noon', [2026, 10, 11, 12, 0], false],
    ['midnight', [2026, 10, 11, 0, 0], false],
    ['at 8', [2026, 10, 10, 20, 0], true],
    ['thursday at 9 am', [2026, 10, 12, 9, 0], false],
    ['2026-11-12T08:00', [2026, 10, 12, 8, 0], false],
  ];
  for (const [text, want, amb] of rows) {
    const r = parseWhen(text, NOW);
    assert.ok(r, text);
    assert.equal(r.at, at(...want), `${text} → ${new Date(r.at)}`);
    assert.equal(r.ambiguous, amb, `${text} ambiguous`);
  }
});

test('timers parse: relative "in" and nonsense', () => {
  assert.equal(parseWhen('in 20 minutes', NOW).at, NOW + 20 * 60e3);
  assert.equal(parseWhen('someday', NOW), null);
  assert.equal(parseWhen('at 25', NOW), null);
  assert.equal(parseWhen('13:75', NOW), null);
});

test('timers parse: sayTime names the day', () => {
  assert.equal(sayTime(at(2026, 10, 11, 7, 0), NOW), '7:00 AM tomorrow');
  assert.equal(sayTime(at(2026, 10, 10, 21, 5), NOW), '9:05 PM today');
  assert.equal(sayTime(at(2026, 10, 12, 9, 0), NOW), '9:00 AM on Thursday');
  assert.equal(sayTime(at(2026, 10, 30, 9, 0), NOW), '9:00 AM on Monday, November 30');
});

test('timers parse: DST night uses local wall time, not +24 h', () => {
  const now = new Date(2026, 2, 7, 22, 0).getTime();   // US DST starts 8 Mar 2026
  assert.equal(parseWhen('9 am', now).at, new Date(2026, 2, 8, 9, 0).getTime());
});
