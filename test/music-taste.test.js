// "Songs you'd like" from the play graph (W2 §4, plan E12, E13, E20).
const test = require('node:test');
const assert = require('node:assert/strict');
const { cortexOn } = require('./helpers/cortex');
const { createPlayLog } = require('../src/core/music/log');
const { createTaste } = require('../src/core/music/taste');
const { createMusicStatsTool } = require('../src/core/tools/musicstats');
const { createYtMusicTool } = require('../src/core/tools/media');

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 10, 12);
const id11 = s => s.padEnd(11, 'x');
const T = { a: ['A Song', 'Alpha'], b: ['B Song', 'Beta'], c: ['C Song', 'Gamma'], e: ['E Song', 'Delta'], f: ['F Song', 'Eps'], g: ['G Song', 'Alpha'] };
function world() {
  const cortex = cortexOn();
  const playLog = createPlayLog({ cortex, now: () => NOW });
  let t = NOW - 20 * DAY;
  const play = (k, { secs = 200, at } = {}) => {
    const s = at ?? t;
    playLog.add({ videoId: id11('v' + k), title: T[k][0], artist: T[k][1], startedAt: s, listenedMs: secs * 1000, duration: 200, reason: secs >= 200 ? 'ended' : 'track-change' });
    t = s + secs * 1000 + 5000;
  };
  const session = (...ks) => { for (const k of ks) play(k); t += 3 * 3600e3; };
  session('a', 'b'); session('a', 'b'); session('a', 'b'); session('a', 'c');
  session('a', 'f'); play('a'); play('f', { secs: 40 }); t += 3 * 3600e3; play('a'); play('f', { secs: 40 }); t += 3 * 3600e3; play('f', { secs: 40 });
  session('a', 'e'); play('e', { at: NOW - 2 * 3600e3 });   // e was played in the last 24 h
  const taste = createTaste({ cortex, playLog, now: () => NOW });
  return { cortex, playLog, taste, play, session };
}
const ids = list => list.map(x => x.videoId);

test('music-taste: the track most often played after the current one ranks first', () => {
  const { taste } = world();
  const out = taste.suggest({ n: 5, current: { title: 'A Song', artist: 'Alpha' } });
  assert.equal(out[0].videoId, id11('vb'));
  assert.ok(ids(out).includes(id11('vc')));
  assert.equal(out[0].title, 'B Song'); assert.equal(out[0].artist, 'Beta');
});

test('music-taste: tracks played in the last 24 h are left out', () => {
  assert.ok(!ids(world().taste.suggest({ n: 10, current: { title: 'A Song', artist: 'Alpha' } })).includes(id11('ve')));
});

test('music-taste: tracks skipped more than 60% are left out', () => {
  assert.ok(!ids(world().taste.suggest({ n: 10, current: { title: 'A Song', artist: 'Alpha' } })).includes(id11('vf')));
});

test('music-taste: the exclude list and the seed are never returned', () => {
  const out = world().taste.suggest({ n: 10, current: { title: 'A Song', artist: 'Alpha' }, exclude: [id11('vb')] });
  assert.ok(!ids(out).includes(id11('vb')));
  assert.ok(!ids(out).includes(id11('va')));
});

test('music-taste: why names the strongest edge', () => {
  const { taste, cortex, playLog } = world();
  const out = taste.suggest({ n: 5, current: { title: 'A Song', artist: 'Alpha' } });
  assert.equal(out[0].why, 'you often play it after A Song');
  // a track only reachable through its artist
  playLog.add({ videoId: id11('vg'), title: 'G Song', artist: 'Alpha', startedAt: NOW - 10 * DAY, listenedMs: 200000, duration: 200, reason: 'ended' });
  const g = taste.suggest({ n: 10, current: { title: 'A Song', artist: 'Alpha' } }).find(x => x.videoId === id11('vg'));
  assert.equal(g.why, 'you like Alpha');
  // a playlist link
  const src = cortex.source.add({ kind: 'tool', ref: 't' });
  const pl = cortex.node.upsert({ kind: 'playlist', key: 'playlist:PLx', text: 'Gym', source: src }).id;
  const c = cortex.node.find({ kind: 'track', key: 'track:' + id11('vc') }).id;
  cortex.link(pl, c, 'contains', { weight: 1 });
  const a = cortex.node.find({ kind: 'track', key: 'track:' + id11('va') }).id;
  cortex.link(pl, a, 'contains', { weight: 1 });
  cortex.unlinkAll(a, 'next');
  const cc = taste.suggest({ n: 10, current: { title: 'A Song', artist: 'Alpha' } }).find(x => x.videoId === id11('vc'));
  assert.equal(cc.why, 'it is in your Gym playlist');
});

test('music-taste: the artist option keeps only that artist', () => {
  const { taste, playLog } = world();
  playLog.add({ videoId: id11('vg'), title: 'G Song', artist: 'Alpha', startedAt: NOW - 10 * DAY, listenedMs: 200000, duration: 200, reason: 'ended' });
  const out = taste.suggest({ n: 10, artist: 'alpha' });
  assert.ok(ids(out).includes(id11('vg')));
  assert.ok(out.every(x => x.artist === 'Alpha'), JSON.stringify(out));
});

test('music-taste: an unknown current track falls back to the top artists', () => {
  const out = world().taste.suggest({ n: 10, current: { title: 'Nothing', artist: 'Nobody' } });
  assert.ok(out.length > 0);
});

test('music-taste: an empty graph and a cold start give nothing', () => {
  const cortex = cortexOn();
  const taste = createTaste({ cortex, playLog: createPlayLog({ cortex, now: () => NOW }), now: () => NOW });
  assert.deepEqual(taste.suggest({ n: 5 }), []);
  assert.deepEqual(taste.suggest({ n: 5, current: { title: 'A', artist: 'B' }, artist: 'B' }), []);
});

test('music_stats: the taste report lists picks with why; still importing is said first', async () => {
  const { playLog, taste } = world();
  const tool = createMusicStatsTool({ playLog, taste });
  assert.ok(tool.params.properties.report.enum.includes('taste'));
  const out = await tool.run({ report: 'taste' });
  assert.match(out, /B Song - Beta \(you /);
  playLog.importing.active = true; playLog.importing.pct = 41;
  assert.match(await tool.run({ report: 'overview' }), /^Still importing your older plays \(41%\); these numbers are partial\./);
  assert.ok(!createMusicStatsTool({ playLog }).params.properties.report.enum.includes('taste'));
});

function fakeYtm() {
  return {
    connected: true, played: [], queued: [], randoms: [],
    async play(q) { this.played.push(q); return { ok: true, started: true, item: { title: q.split(' by ')[0], artists: [q.split(' by ')[1]] } }; },
    async enqueue(q) { this.queued.push(q); return { ok: true, item: { title: q.split(' by ')[0], artists: [q.split(' by ')[1]] } }; },
    async playRandom(a) { this.randoms.push(a); return { ok: true, started: true, item: { title: 'Rand', artists: [a] } }; },
    async queueRandom(a, n) { this.randoms.push(a); return { ok: true, added: [{ title: 'Rand', artists: [a] }], failed: 0 }; },
  };
}
const picks = [{ videoId: 'v1xxxxxxxxx', title: 'B Song', artist: 'Beta', why: 'you often play it after A Song' }, { videoId: 'v2xxxxxxxxx', title: 'C Song', artist: 'Gamma', why: 'you like Gamma' }];

test('youtube_music: play_random without a query plays the first suggestion by search', async () => {
  const ytm = fakeYtm(); let asked;
  const tool = createYtMusicTool({ ytm, taste: { suggest: o => { asked = o; return picks; } }, current: async () => ({ title: 'A Song', artist: 'Alpha' }) });
  const out = await tool.run({ action: 'play_random' });
  assert.deepEqual(ytm.played, ['B Song by Beta']);
  assert.match(out, /B Song/); assert.match(out, /you often play it after A Song/);
  assert.equal(asked.current.title, 'A Song');
});

test('youtube_music: queue_random "songs you think I\'d like" queues the suggestions', async () => {
  const ytm = fakeYtm();
  const tool = createYtMusicTool({ ytm, taste: { suggest: ({ n }) => picks.slice(0, n) } });
  const out = await tool.run({ action: 'queue_random', query: "songs you think I'd like", count: 2 });
  assert.deepEqual(ytm.queued, ['B Song by Beta', 'C Song by Gamma']);
  assert.match(out, /Added 2/);
});

test('youtube_music: an artist with no taste picks uses the artist search as before', async () => {
  const ytm = fakeYtm();
  const tool = createYtMusicTool({ ytm, taste: { suggest: () => [] } });
  await tool.run({ action: 'play_random', query: 'Queen' });
  assert.deepEqual(ytm.randoms, ['Queen']);
  assert.deepEqual(ytm.played, []);
});

test('youtube_music: no taste and no artist says so', async () => {
  const tool = createYtMusicTool({ ytm: fakeYtm(), taste: { suggest: () => [] } });
  await assert.rejects(tool.run({ action: 'play_random' }), /I don't know your taste yet\. Name an artist\./);
  await assert.rejects(createYtMusicTool({ ytm: fakeYtm() }).run({ action: 'play_random' }), /query is required|Name an artist/);
});

test('music-taste: an artist seed reaches all of its tracks, not five', () => {
  const cortex = cortexOn();
  const playLog = createPlayLog({ cortex, now: () => NOW });
  for (let i = 0; i < 30; i++) playLog.add({ videoId: id11('q' + i), title: 'Queen Song ' + i, artist: 'Queen', startedAt: NOW - (10 + i) * DAY, listenedMs: 200000, duration: 200, reason: 'ended' });
  const out = createTaste({ cortex, playLog, now: () => NOW }).suggest({ n: 10 });
  assert.equal(new Set(ids(out)).size, 10);
  assert.ok(out.every(x => x.artist === 'Queen' && x.why === 'you like Queen'));
  assert.equal(createTaste({ cortex, playLog, now: () => NOW }).suggest({ n: 25, artist: 'queen' }).length, 25);
});

test('youtube_music: "Queen for me" keeps the artist', async () => {
  let asked;
  const tool = createYtMusicTool({ ytm: fakeYtm(), taste: { suggest: o => { asked = o; return picks; } } });
  await tool.run({ action: 'play_random', query: 'Queen for me' });
  assert.equal(asked.artist, 'queen');
  await tool.run({ action: 'play_random', query: "songs you think I'd like" });
  assert.equal(asked.artist, null);
});
