const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTracker } = require('../extension/tracker');
const { createPlayLog, normalize } = require('../src/core/music/log');
const { cortexOn } = require('./helpers/cortex');
const { report, periodRange } = require('../src/core/music/stats');
const { createMusicStatsTool } = require('../src/core/tools/musicstats');
const { route } = require('../src/core/brain/router');
const { DEFAULTS } = require('../src/core/config');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jmusic-')), 'plays.jsonl');
const T0 = new Date(2026, 10, 9, 21, 0, 0).getTime();   // Mon 9 Nov 2026, 9 pm local

// ---- tracker: drive it second by second like the page does ----
function play(tracker, s, secs, start, { state = 1 } = {}) {
  for (let i = 0; i <= secs; i++) tracker.tick({ videoId: s.videoId, title: s.title, artist: s.artist, album: s.album || '', state, time: (s.from || 0) + i, duration: s.duration, list: s.list || null, like: s.like || null }, start + i * 1000);
  return start + secs * 1000;
}

test('tracker: a finished track, a skip, a repeat and a seek become plays with the right facts', () => {
  const out = [];
  const t = createTracker({ emit: e => out.push(e) });
  let now = T0;
  now = play(t, { videoId: 'aaaaaaaaaaa', title: 'One', artist: 'Band', duration: 60, list: 'PLx' }, 59, now);
  now += 1000; t.tick({ videoId: 'aaaaaaaaaaa', title: 'One', artist: 'Band', state: 0, time: 60, duration: 60 }, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'ended'); assert.equal(out[0].list, 'PLx'); assert.ok(out[0].listenedMs >= 59000);
  now += 2000;
  now = play(t, { videoId: 'bbbbbbbbbbb', title: 'Two', artist: 'Band', duration: 200 }, 8, now);   // skipped after 8 s
  now = play(t, { videoId: 'ccccccccccc', title: 'Three', artist: 'Other', duration: 200 }, 5, now + 1000);
  assert.equal(out.length, 2);
  assert.equal(out[1].reason, 'track-change'); assert.equal(out[1].title, 'Two'); assert.ok(out[1].listenedMs >= 7000 && out[1].listenedMs <= 9000);
  // seek forward 60 s inside "Three", then keep playing
  now = play(t, { videoId: 'ccccccccccc', title: 'Three', artist: 'Other', duration: 200, from: 70 }, 5, now + 1000);
  t.flush(now);
  assert.equal(out.at(-1).title, 'Three'); assert.equal(out.at(-1).seeks, 1); assert.equal(out.at(-1).reason, 'closed');
  // replay of the same video (time jumps back to ~0 after a long listen) closes the first play
  const r = [];
  const t2 = createTracker({ emit: e => r.push(e) });
  let n2 = play(t2, { videoId: 'ddddddddddd', title: 'Loop', artist: 'Band', duration: 30 }, 29, T0);
  n2 = play(t2, { videoId: 'ddddddddddd', title: 'Loop', artist: 'Band', duration: 30 }, 10, n2 + 1000);
  assert.equal(r.length, 1); assert.equal(r[0].reason, 'repeat');
});

test('tracker: paused time is not listening; a long pause closes the play; under one second is noise', () => {
  const out = [];
  const t = createTracker({ emit: e => out.push(e), idleMs: 60000 });
  let now = play(t, { videoId: 'aaaaaaaaaaa', title: 'One', artist: 'Band', duration: 300 }, 20, T0);
  now = play(t, { videoId: 'aaaaaaaaaaa', title: 'One', artist: 'Band', duration: 300, from: 20 }, 90, now + 1000, { state: 2 });   // 90 s paused
  assert.equal(out.length, 1); assert.equal(out[0].reason, 'idle');
  assert.ok(out[0].listenedMs >= 19000 && out[0].listenedMs <= 22000, `listened ${out[0].listenedMs}`);
  const tiny = [];
  const t2 = createTracker({ emit: e => tiny.push(e) });
  t2.tick({ videoId: 'bbbbbbbbbbb', state: 1, time: 0, duration: 100 }, T0); t2.tick({ videoId: 'bbbbbbbbbbb', state: 1, time: 0.4, duration: 100 }, T0 + 400); t2.flush(T0 + 500);
  assert.equal(tiny.length, 0);
  t2.tick(null, T0 + 900);   // no player: nothing happens
});

// ---- log ----
const ev = (o = {}) => ({ id: `${T0}-aaaaaaaaaaa`, videoId: 'aaaaaaaaaaa', title: 'One', artist: 'Band, Guest', album: 'LP', startedAt: T0, endedAt: T0 + 60000, listenedMs: 60000, duration: 60, seeks: 0, reason: 'ended', list: null, like: null, ...o });

test('log: outcomes, quick skips, artists; junk rejected', () => {
  assert.equal(normalize(ev()).outcome, 'finished');
  assert.deepEqual(normalize(ev()).artists, ['Band', 'Guest']);
  const q = normalize(ev({ listenedMs: 8000, duration: 200, reason: 'track-change' }));
  assert.deepEqual([q.outcome, q.quickSkip], ['skipped', true]);
  const part = normalize(ev({ listenedMs: 120000, duration: 200, reason: 'track-change' }));
  assert.deepEqual([part.outcome, part.quickSkip], ['partial', false]);
  assert.equal(normalize(ev({ duration: 0 })).outcome, 'unknown');
  assert.equal(normalize(ev({ like: 'LIKE' })).liked, true);
  for (const bad of [null, {}, ev({ videoId: '!!' }), ev({ listenedMs: 100 }), ev({ startedAt: 'x' }), ev({ startedAt: T0 * 3 })]) assert.equal(normalize(bad, { now: T0 + 1e6 }), null);
});

test('log: stores once, keeps time order, survives restart, honours the off switch and clear', () => {
  const file = tmp();
  let cfg = { music: { logPlays: true } };
  const log = createPlayLog({ cortex: cortexOn(file), getConfig: () => cfg, now: () => T0 + 1e7 });
  assert.ok(log.add(ev({ id: 'b', startedAt: T0 + 5000, videoId: 'bbbbbbbbbbb' })));
  assert.ok(log.add(ev({ id: 'a', startedAt: T0, videoId: 'aaaaaaaaaaa' })));
  assert.equal(log.add(ev({ id: 'a' })), null, 'same id twice');
  assert.deepEqual(log.all().map(p => p.id), ['a', 'b']);
  cfg = { music: { logPlays: false } };
  assert.equal(log.add(ev({ id: 'c', startedAt: T0 + 9000 })), null);
  cfg = { music: { logPlays: true } };
  log.all(); // (a torn line in the old file is the import's business now: music-import.test.js)
  const again = createPlayLog({ cortex: cortexOn(file), getConfig: () => cfg });
  assert.equal(again.count(), 2); assert.equal(again.since(), T0);
  again.clear();
  assert.equal(again.count(), 0);
  assert.equal(DEFAULTS.music.logPlays, true);
});

// ---- stats ----
function lib() {
  const log = createPlayLog({ cortex: cortexOn(tmp()), now: () => T0 + 400 * 86400000 });
  let n = 0;
  const add = (artist, title, day, hour, listened, duration = 200, o = {}) => log.add(ev({ id: `p${n++}`, videoId: ('v' + title.replace(/\W/g, '')).padEnd(11, 'x').slice(0, 11), title, artist, startedAt: new Date(2026, 10, day, hour, n % 50).getTime(), listenedMs: listened * 1000, duration, reason: listened >= duration ? 'ended' : 'track-change', ...o }));
  for (let d = 1; d <= 8; d++) { add('Scrim', 'Cortisol', d, 22, 200); add('Scrim', 'Via Crucis', d, 22, 200); }
  for (let i = 0; i < 6; i++) add('Pop Act', 'Hit', 5, 14, i < 5 ? 10 : 200);   // skipped 5 of 6 (quick)
  add('Old Band', 'Ancient', 2, 3, 200); add('Old Band', 'Ancient', 2, 3, 200); add('Old Band', 'Ancient', 2, 4, 200);
  return log.all();
}
const NOW = new Date(2026, 10, 10, 12, 0).getTime();

test('stats: period parsing', () => {
  assert.equal(periodRange('today', NOW).from, new Date(2026, 10, 10).getTime());
  assert.equal(periodRange('7', NOW).label, 'the last 7 days');
  assert.equal(periodRange('last 30 days', NOW).label, 'the last 30 days');
  assert.equal(periodRange('all', NOW).from, 0);
  assert.equal(periodRange('nonsense', NOW).label, 'the last 30 days');
});

test('stats: overview, top lists, skips, time of day, repeats, sessions, artist, recent, discovery, trends', () => {
  const plays = lib();
  const run = (r, o = {}) => report(plays, { report: r, period: 'all', now: NOW, ...o });
  const ov = run('overview');
  assert.equal(ov.data.plays, 25); assert.equal(ov.data.uniqueArtists, 3);
  assert.match(ov.text, /25 plays/); assert.match(ov.text, /Most time on Scrim/);
  assert.match(run('top_artists').text, /1\. Scrim: 16 plays/);
  assert.match(run('top_artists', { by: 'plays' }).text, /1\. Scrim/);
  assert.match(run('top_tracks').text, /Cortisol - Scrim: 8 plays/);
  const sk = run('skips');
  assert.match(sk.text, /Pop Act 83\.3% of 6/); assert.match(sk.text, /Never skipped: Scrim/);
  assert.match(run('time_of_day').text, /night 12-5am/);
  assert.match(run('weekday').text, /Sunday|Monday|Tuesday/);
  assert.match(run('repeats').text, /Hit - Pop Act x6 on/);
  assert.match(run('sessions').text, /sessions/);
  assert.match(run('artist', { name: 'scrim' }).text, /16 plays/);
  assert.match(run('artist', { name: 'nobody' }).text, /No plays of "nobody"/);
  assert.match(run('recent', { limit: 3 }).text, /Recent plays/);
  assert.match(run('discovery', { period: '3' }).text, /heard for the first time/);
  assert.match(run('trends').text, /at least two months/);
  assert.match(run('sources').text, /not from a playlist/);
  assert.match(report(plays, { report: 'bogus', now: NOW }).text, /Unknown report/);
  assert.match(report([], { report: 'overview' }).text, /No listening has been logged yet/);
  assert.match(report(plays, { report: 'overview', period: 'today', now: NOW + 400 * 86400000 }).text, /No plays logged for today/);
});

test('stats: trends compare months and count new artists', () => {
  const log = createPlayLog({ cortex: cortexOn(tmp()), now: () => T0 + 1e10 });
  const m = (artist, month, i) => log.add(ev({ id: `${artist}${month}${i}`, videoId: ('v' + artist + month + i).replace(/\W/g, '').padEnd(11, 'x').slice(0, 11), artist, startedAt: new Date(2026, month, 5 + i, 12).getTime() }));
  for (let i = 0; i < 3; i++) { m('A', 8, i); m('A', 9, i); }
  m('B', 9, 5);
  const t = report(log.all(), { report: 'trends', period: 'all', now: NOW }).text;
  assert.match(t, /2026-09: .*\(1 new\)/);
  assert.match(t, /2026-10: .*\(1 new\).*similarity to last month 9\d%/);
});

test('tool: music_stats answers from the log, caps limits, and the router sends taste questions to tools', async () => {
  const log = createPlayLog({ cortex: cortexOn(tmp()), now: () => T0 + 1e9 });
  for (const p of lib()) log.add({ ...p, startedAt: p.at, listenedMs: p.listenedSec * 1000, duration: p.durationSec, like: null });
  const tool = createMusicStatsTool({ playLog: log });
  assert.equal(tool.name, 'music_stats');
  const out = await tool.run({ report: 'top_artists', period: 'all', limit: 999 });
  assert.match(out, /Top artists/); assert.match(out, /Log covers 25 plays since/);
  assert.match(await tool.run({}), /No plays logged|Listening/);
  for (const q of ['what are my top artists', 'how often do I skip songs', 'what did I listen to last week', 'what is my music taste', 'what is my skip rate']) assert.equal(route(q).tools, true, q);
});
