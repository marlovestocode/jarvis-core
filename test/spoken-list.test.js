const test = require('node:test');
const assert = require('node:assert/strict');
const { spokenDuration, parseClock, spokenSongs, pick } = require('../src/core/voice/spoken-list');

const SCRIM = [['clairaudience', '2:37'], ['tale of the missing man', '2:58'], ['a nice place to visit', '2:22'], ['Jesus Wept', '2:01'],
  ['operation fishnet', '2:37'], ['a nightmare worth pursuing', '4:57'], ['1st things first', '2:28'], ['warped lives of blameless children', '2:47'],
  ['staring at the dust', '2:52'], ['heaven 4 a fiend', '2:26'], ['ex nihlio', '2:11'], ['Delusions of Grandeur', '2:50']]
  .map(([title, duration]) => ({ title, artist: 'Scrim', duration }));

test('parseClock reads m:ss and h:mm:ss and refuses anything else', () => {
  assert.equal(parseClock('2:37'), 157);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(undefined), null);
});

test('spokenDuration rounds like a person', () => {
  assert.equal(spokenDuration(20), 'under a minute');
  assert.equal(spokenDuration(75), 'about a minute');
  assert.equal(spokenDuration(5 * 60 + 10), 'about five minutes');
  assert.equal(spokenDuration(33 * 60 + 6), 'about thirty-five minutes');
  assert.equal(spokenDuration(29 * 60), 'about half an hour');
  assert.equal(spokenDuration(61 * 60), 'about an hour');
  assert.equal(spokenDuration(90 * 60), 'about an hour and a half');
  assert.equal(spokenDuration(2 * 3600 + 5 * 60), 'about two hours');
  assert.equal(spokenDuration(3 * 3600 + 28 * 60), 'about three and a half hours');
  assert.equal(spokenDuration(0), 'under a minute');
});

test('spokenSongs: the 12-song Scrim queue reads once, with the artist said once and the rest counted', () => {
  const s = spokenSongs(SCRIM);
  assert.match(s, /^Twelve from Scrim: clairaudience, tale of the missing man, a nice place to visit, then Jesus Wept\./);
  assert.match(s, /Eight more after that\.$/);
  assert.doesNotMatch(s, /\d\./);
  assert.doesNotMatch(s, /\(\d:\d\d\)/);
  assert.doesNotMatch(s, /by Scrim/);
});

test('spokenSongs: one song, two artists, small lists and the cutoff boundary', () => {
  assert.equal(spokenSongs([{ title: 'Alpha', artist: 'Band' }]), 'Alpha by Band');
  assert.equal(spokenSongs([{ title: 'Alpha', artist: 'Band' }, { title: 'Beta', artist: 'Other' }]), 'Alpha by Band and Beta by Other.');
  assert.equal(spokenSongs(SCRIM.slice(0, 3)), 'Three from Scrim: clairaudience, tale of the missing man and a nice place to visit.');
  const four = spokenSongs(SCRIM.slice(0, 4));
  assert.match(four, /then Jesus Wept\.$/);
  assert.doesNotMatch(four, /more after that/);
  assert.match(spokenSongs(SCRIM.slice(0, 5)), /One more after that\.$/);
  assert.equal(spokenSongs([]), '');
});

test('spokenSongs: titles that look like numbers or times are not touched', () => {
  assert.match(spokenSongs([{ title: '3:00', artist: 'A' }, { title: '2026', artist: 'A' }]), /3:00 and 2026/);
  assert.match(spokenSongs(SCRIM), /./);
});

test('pick never repeats a line twice in a row and copes with one variant', () => {
  const v = ['Done.', 'Got it.', 'There.'];
  let last = null;
  for (let i = 0; i < 60; i++) { const x = pick(v, 'test-key'); assert.ok(v.includes(x)); assert.notEqual(x, last); last = x; }
  assert.equal(pick(['only'], 'single'), 'only');
  assert.equal(pick(['only'], 'single'), 'only');
});
