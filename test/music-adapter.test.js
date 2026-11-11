// The play log on the cortex (W2 §2, §3): stats parity with the old file log, the play graph (E8), de-dupe (E6).
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cortexOn } = require('./helpers/cortex');
const { createPlayLog } = require('../src/core/music/log');
const { trackKey, artistKey } = require('../src/core/music/adapter');
const { report, REPORTS } = require('../src/core/music/stats');
const { makeEvents, makePlays, goldenCases } = require('./fixtures/music-plays');
const golden = require('./fixtures/music-stats-golden.json');

const T = Date.UTC(2026, 10, 1, 20);
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jplays-'));
const raw = (o = {}) => ({ videoId: 'aaaaaaaaaaa', title: 'One', artist: 'Band', album: '', startedAt: T, listenedMs: 200000, duration: 200, reason: 'ended', ...o });
const LATER = () => Date.UTC(2030, 0, 1);
function logOn(d = dir(), o = {}) { const cortex = cortexOn(d); return { cortex, log: createPlayLog({ cortex, now: LATER, ...o }) }; }
const tid = (cortex, v) => cortex.node.find({ kind: 'track', key: trackKey(v) })?.id;
const nextW = (cortex, a, b) => cortex.neighbors(tid(cortex, a), { types: ['next'] }).find(n => n.id === tid(cortex, b))?.weight;

test('music-adapter: golden — the cortex play log gives the same 39 report texts as the old file log', () => {
  const { log } = logOn();
  let stored = 0;
  for (const e of makeEvents()) if (log.add(e)) stored++;
  assert.equal(stored, golden.stored);
  const cases = goldenCases(log.all(), report, REPORTS);
  assert.equal(cases.length, 39);
  for (const [i, c] of cases.entries()) assert.equal(c.text, golden.cases[i].text, c.name);
});

test('music-adapter: parity — report(playLog.all()) equals report(plays) for every report', () => {
  const { log } = logOn();
  const plays = makePlays().sort((a, b) => a.at - b.at);
  for (const e of makeEvents()) log.add(e);
  for (const name of REPORTS) assert.equal(report(log.all(), { report: name, period: 'all', now: LATER() }).text, report(plays, { report: name, period: 'all', now: LATER() }).text, name);
});

test('music-adapter: add returns the stored play; count, since and range', () => {
  const { log } = logOn();
  const p = log.add(raw());
  assert.equal(p.videoId, 'aaaaaaaaaaa'); assert.equal(p.outcome, 'finished');
  log.add(raw({ videoId: 'bbbbbbbbbbb', startedAt: T + 300000 }));
  assert.equal(log.count(), 2); assert.equal(log.since(), T);
  assert.deepEqual(log.range({ since: T + 1 }).map(x => x.videoId), ['bbbbbbbbbbb']);
});

test('music-adapter: logPlays off and junk write nothing', () => {
  let cfg = { music: { logPlays: false } };
  const { log, cortex } = logOn(dir(), { getConfig: () => cfg });
  assert.equal(log.add(raw()), null);
  cfg = {};
  assert.equal(log.add({ videoId: '!!' }), null);
  assert.equal(cortex.event.count({ kind: 'play' }), 0);
});

test('music-adapter: a late duplicate after a reopen is stored once and does not strengthen next again', () => {
  const d = dir();
  let { log, cortex } = logOn(d);
  log.add(raw());
  log.add(raw({ videoId: 'bbbbbbbbbbb', startedAt: T + 205000 }));
  const w = nextW(cortex, 'aaaaaaaaaaa', 'bbbbbbbbbbb');
  assert.ok(w > 0.14 && w < 0.16, String(w));
  cortex.close();
  ({ log, cortex } = logOn(d));
  assert.equal(log.add(raw({ videoId: 'bbbbbbbbbbb', startedAt: T + 205000 })), null);
  assert.equal(cortex.event.count({ kind: 'play' }), 2);
  assert.ok(Math.abs(nextW(cortex, 'aaaaaaaaaaa', 'bbbbbbbbbbb') - w) < 1e-6);
});

test('music-adapter: a late out-of-order play keeps all() sorted', () => {
  const { log } = logOn();
  log.add(raw({ startedAt: T + 1e6 }));
  log.all();
  log.add(raw({ videoId: 'ccccccccccc', startedAt: T }));
  assert.deepEqual(log.all().map(p => p.videoId), ['ccccccccccc', 'aaaaaaaaaaa']);
});

test('music-adapter: finished transitions build next at 0.15 and grow it', () => {
  const { log, cortex } = logOn();
  let t = T;
  for (let i = 0; i < 2; i++) {
    log.add(raw({ startedAt: t })); t += 205000;
    log.add(raw({ videoId: 'bbbbbbbbbbb', startedAt: t })); t += 3600e3;
  }
  assert.ok(Math.abs(nextW(cortex, 'aaaaaaaaaaa', 'bbbbbbbbbbb') - (0.15 + 0.15 * 0.85)) < 1e-3);
  assert.equal(cortex.neighbors(tid(cortex, 'bbbbbbbbbbb'), { types: ['next'] }).filter(n => n.id === tid(cortex, 'aaaaaaaaaaa')).length, 1);   // the a→b edge seen from b, none b→a stored
});

test('music-adapter: a quick skip scales the previous→skipped edge × 0.6 and no other', () => {
  const { log, cortex } = logOn();
  log.add(raw()); log.add(raw({ videoId: 'bbbbbbbbbbb', startedAt: T + 205000 }));
  log.add(raw({ videoId: 'ccccccccccc', startedAt: T + 410000 }));
  log.add(raw({ startedAt: T + 4 * 3600e3 }));
  const ab = nextW(cortex, 'aaaaaaaaaaa', 'bbbbbbbbbbb'), bc = nextW(cortex, 'bbbbbbbbbbb', 'ccccccccccc');
  log.add(raw({ videoId: 'bbbbbbbbbbb', startedAt: T + 4 * 3600e3 + 205000, listenedMs: 5000, reason: 'track-change' }));
  assert.ok(Math.abs(nextW(cortex, 'aaaaaaaaaaa', 'bbbbbbbbbbb') - ab * 0.6) < 1e-3);
  assert.ok(Math.abs(nextW(cortex, 'bbbbbbbbbbb', 'ccccccccccc') - bc) < 1e-6);
});

test('music-adapter: a gap over 30 min or the same track again makes no edge', () => {
  const { log, cortex } = logOn();
  log.add(raw()); log.add(raw({ startedAt: T + 205000 }));
  log.add(raw({ videoId: 'bbbbbbbbbbb', startedAt: T + 410000 + 31 * 60000 }));
  assert.equal(cortex.neighbors(tid(cortex, 'aaaaaaaaaaa'), { types: ['next'] }).length, 0);
});

test('music-adapter: a song called "Secret" by U2 is stored with track and artist nodes', () => {
  const { log, cortex } = logOn();
  assert.ok(log.add(raw({ title: 'Secret', artist: 'U2, Bono' })));
  const t = cortex.node.find({ kind: 'track', key: trackKey('aaaaaaaaaaa') });
  assert.equal(t.text, 'Secret — U2, Bono'); assert.equal(t.data.videoId, 'aaaaaaaaaaa');
  assert.equal(cortex.node.find({ kind: 'artist', key: artistKey('U2') }).text, 'U2 (artist)');
  assert.equal(cortex.neighbors(t.id, { types: ['by'] }).length, 2);
});

test('music-adapter: trim drops the cache, all() reloads', () => {
  const { log } = logOn();
  log.add(raw());
  assert.equal(log.all().length, 1);
  log.trim();
  assert.equal(log.stats().cached, 0);
  assert.equal(log.all().length, 1);
});
