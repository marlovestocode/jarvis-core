const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlayLog } = require('../src/core/music/log');

const play = (i, artist = 'Daft Punk') => ({ videoId: 'abcdefghijk', startedAt: 1700000000000 + i * 300000, listenedMs: 180000, duration: 200, title: 'One More Time', artist, album: 'Discovery', reason: 'ended' });

test('play log: the same song and artist share their strings and artist list in memory, and read back the same', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-plays-')), 'plays.jsonl');
  const log = createPlayLog({ file, now: () => 1800000000000 });
  for (let i = 0; i < 50; i++) log.add(play(i, i % 2 ? 'Daft Punk' : 'Justice, Daft Punk'));
  const all = log.all();
  assert.equal(all.length, 50);
  assert.equal(all[0].artists, all[2].artists, 'one shared artist list per distinct artist string');
  assert.notEqual(all[0].artists, all[1].artists);
  assert.deepEqual(all[0].artists, ['Justice', 'Daft Punk']);
  assert.equal(all[1].title, 'One More Time');
  // a fresh start reads the file and gets the same plays, shared the same way
  const again = createPlayLog({ file, now: () => 1800000000000 });
  assert.equal(again.count(), 50);
  assert.equal(again.all()[0].artists, again.all()[2].artists);
  assert.deepEqual(again.all().map(p => p.id), all.map(p => p.id));
  again.clear();
  assert.equal(again.count(), 0);
});

test('playlists: only the latest few playlists keep their songs in memory; an evicted one is fetched again', async () => {
  const { createYtPlaylists } = require('../src/core/media/ytplaylists');
  let fetched = 0;
  const link = { connected: true, request: async (cmd, args) => { fetched++; return { id: args.id, title: args.id, editable: true, tracks: [{ videoId: 'v' + fetched, setVideoId: 's' + fetched, title: 'T', artists: ['A'] }] }; } };
  const yp = createYtPlaylists({ link, getConfig: () => ({ music: { playlistTtlSec: 3600 } }), sleep: async () => {} });
  for (let i = 0; i < 12; i++) await yp.playlist({ id: 'PL' + i, title: 'P' + i });
  assert.equal(fetched, 12);
  await yp.playlist({ id: 'PL11', title: 'P11' });   // newest: still cached
  assert.equal(fetched, 12);
  await yp.playlist({ id: 'PL0', title: 'P0' });     // oldest: was evicted, so it asks again
  assert.equal(fetched, 13);
});
