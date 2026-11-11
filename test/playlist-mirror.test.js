// Playlist nodes mirrored from the extension (W2 §2, plan E11). YouTube stays the truth; the cortex keeps a copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cortexOn } = require('./helpers/cortex');
const { createPlaylistMirror } = require('../src/core/media/mirror');
const { createYtPlaylists } = require('../src/core/media/ytplaylists');

const T = (videoId, title, artist) => ({ videoId, title, artists: [artist] });
const members = (c, id) => c.neighbors(c.node.find({ kind: 'playlist', key: 'playlist:' + id }).id, { types: ['contains'], limit: 100 }).map(n => c.node.get(n.id).data.videoId).sort();

test('mirror: a library refresh upserts playlists and archives one that is gone', () => {
  const c = cortexOn();
  const m = createPlaylistMirror({ cortex: c, now: () => 5 });
  m.library([{ id: 'PLa', title: 'Gym', count: 3 }, { id: 'PLb', title: 'Hi', count: 1 }]);
  assert.equal(m.get('PLa').text, 'Gym');
  assert.equal(m.get('PLb').text, 'Hi playlist');
  assert.deepEqual(m.get('PLa').data, { id: 'PLa', name: 'Gym', count: 3, fetchedAt: 5 });
  m.library([{ id: 'PLa', title: 'Gym', count: 4 }]);
  assert.equal(m.get('PLa').data.count, 4);
  assert.equal(m.get('PLb').status, 'archived');
});

test('mirror: a track read replaces membership wholesale', () => {
  const c = cortexOn();
  const m = createPlaylistMirror({ cortex: c, now: () => 5 });
  m.playlist({ id: 'PLa', title: 'Gym', tracks: [T('aaaaaaaaaaa', 'One', 'X'), T('bbbbbbbbbbb', 'Two', 'Y')] });
  assert.deepEqual(members(c, 'PLa'), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  m.playlist({ id: 'PLa', title: 'Gym', tracks: [T('bbbbbbbbbbb', 'Two', 'Y'), T('ccccccccccc', 'Three', 'Z')] });
  assert.deepEqual(members(c, 'PLa'), ['bbbbbbbbbbb', 'ccccccccccc']);
  assert.equal(m.get('PLa').data.count, 2);
});

test('mirror: a failure mid-way leaves the old membership', () => {
  const c = cortexOn();
  createPlaylistMirror({ cortex: c }).playlist({ id: 'PLa', title: 'Gym', tracks: [T('aaaaaaaaaaa', 'One', 'X')] });
  let n = 0;
  const flaky = new Proxy(c, { get: (o, k) => (k === 'link' ? (...a) => { if (++n === 2) throw new Error('disk'); return o.link(...a); } : o[k]) });
  assert.throws(() => createPlaylistMirror({ cortex: flaky }).playlist({ id: 'PLa', title: 'Gym', tracks: [T('bbbbbbbbbbb', 'Two', 'Y'), T('ccccccccccc', 'Three', 'Z')] }), /disk/);
  assert.deepEqual(members(c, 'PLa'), ['aaaaaaaaaaa']);
});

function service({ cortex, link }) {
  let t = 1_000_000;
  const mirror = createPlaylistMirror({ cortex, now: () => t });
  const svc = createYtPlaylists({ link, mirror, now: () => t, sleep: async ms => { t += ms; } });
  return { svc, mirror, tick: ms => { t += ms; } };
}
function fakeLink() {
  return {
    connected: true, info: { version: '1.2.0' }, down: false,
    async request(cmd, args) {
      if (this.down) throw new Error('offline');
      if (cmd === 'playlists') return { playlists: [{ id: 'PLa', title: 'Gym', count: 1, editable: true }] };
      if (cmd === 'playlist') return { id: args.id, editable: true, tracks: [T('aaaaaaaaaaa', 'One', 'X')] };
      throw new Error('unexpected ' + cmd);
    },
  };
}

test('mirror: ytplaylists mirrors a fresh library and track read', async () => {
  const c = cortexOn();
  const { svc, mirror } = service({ cortex: c, link: fakeLink() });
  await svc.open('gym');
  assert.equal(mirror.get('PLa').text, 'Gym');
  assert.deepEqual(members(c, 'PLa'), ['aaaaaaaaaaa']);
});

test('mirror: offline, stale or cached reads leave the mirror as it was (Review Focus 4)', async () => {
  const c = cortexOn();
  const link = fakeLink();
  const { svc, mirror, tick } = service({ cortex: c, link });
  await svc.open('gym');
  const before = JSON.stringify(mirror.get('PLa'));
  await svc.open('gym');                  // cached
  tick(10 * 60e3); link.down = true;
  const r = await svc.library();          // stale
  assert.equal(r.stale, true);
  await assert.rejects(svc.playlist({ id: 'PLa' }, { refresh: true }));
  link.connected = false;
  await assert.rejects(svc.playlist({ id: 'PLa' }, { refresh: true }), /not connected/);
  assert.equal(JSON.stringify(mirror.get('PLa')), before);
  assert.deepEqual(members(c, 'PLa'), ['aaaaaaaaaaa']);
});

test('mirror: contains edges reach a playlist from its tracks', () => {
  const c = cortexOn();
  createPlaylistMirror({ cortex: c }).playlist({ id: 'PLa', title: 'Gym', tracks: [T('aaaaaaaaaaa', 'One', 'X')] });
  const tr = c.node.find({ kind: 'track', key: 'track:aaaaaaaaaaa' });
  assert.equal(c.node.get(c.neighbors(tr.id, { types: ['contains'] })[0].id).kind, 'playlist');
});

test('mirror: a fresh but empty or garbled library read does not wipe the mirror', async () => {
  const c = cortexOn();
  const link = fakeLink();
  const { svc, mirror, tick } = service({ cortex: c, link });
  await svc.open('gym');
  const real = link.request.bind(link);
  link.request = async (cmd, args) => (cmd === 'playlists' ? { oops: true } : cmd === 'playlist' ? { id: args.id, editable: true } : real(cmd, args));
  tick(10 * 60e3);
  await svc.library({ refresh: true });
  await svc.playlist({ id: 'PLa' }, { refresh: true });
  assert.equal(mirror.get('PLa').status, 'active');
  assert.deepEqual(members(c, 'PLa'), ['aaaaaaaaaaa']);
  mirror.library([]);
  assert.equal(mirror.get('PLa').status, 'active');
  assert.deepEqual(members(c, 'PLa'), ['aaaaaaaaaaa']);
});
