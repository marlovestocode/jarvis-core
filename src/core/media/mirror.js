// The user's playlists mirrored into the cortex (W2 §2, plan E11). YouTube Music is the truth: the mirror only follows
// fresh reads from the extension (ytplaylists.js calls it), so an offline or stale read never changes it. A playlist is
// a `playlist` node (key playlist:<id>); its tracks are `contains` edges, replaced wholesale in one transaction.
const { ensureTrack, musicSource } = require('../music/adapter');

const MAX_TRACKS = 5000;
const key = id => 'playlist:' + id;
const text = title => { const t = String(title || '').trim() || 'Untitled'; return (t.length >= 3 ? t : `${t} playlist`).slice(0, 300); };

function createPlaylistMirror({ cortex, now = Date.now }) {
  let source = null;
  const src = () => (source ??= musicSource(cortex));

  // a playlist node with fresh text and data; returns its id
  function put(p, count) {
    const data = { id: String(p.id), name: String(p.title || '').slice(0, 200), count, fetchedAt: now() };
    const found = cortex.node.find({ kind: 'playlist', key: key(p.id) });
    if (!found) return cortex.node.upsert({ kind: 'playlist', key: key(p.id), text: text(p.title), data, source: src() }).id;
    cortex.node.update(found.id, { text: text(p.title), data, status: 'active' }, { source: src() });
    return found.id;
  }

  // the library list (a fresh read): every playlist upserted; mirrored ones that are gone are archived and emptied.
  // An empty list archives nothing: a glitch that returns no playlists must not strip every membership.
  function library(list) {
    const ids = new Set();
    const fresh = (Array.isArray(list) ? list : []).filter(x => x && x.id);
    if (!fresh.length) return;
    cortex.transaction(() => {
      for (const p of fresh) {
        ids.add(key(p.id));
        put(p, Number.isFinite(p.count) ? p.count : null);
      }
      for (const n of cortex.node.list({ kind: 'playlist', status: 'active', limit: 1000 })) {
        if (n.key && !ids.has(n.key)) { cortex.node.archive(n.id); cortex.unlinkAll(n.id, 'contains'); }
      }
    });
  }

  // one playlist's tracks (a fresh read): membership replaced, all of it or none
  function playlist(data) {
    if (!data?.id) return;
    const tracks = (Array.isArray(data.tracks) ? data.tracks : []).filter(t => t && /^[\w-]{6,20}$/.test(String(t.videoId))).slice(0, MAX_TRACKS);
    cortex.transaction(() => {
      const pid = put(data, tracks.length);
      cortex.unlinkAll(pid, 'contains');
      for (const t of tracks) {
        const artists = Array.isArray(t.artists) ? t.artists.filter(Boolean).map(String) : t.artist ? String(t.artist).split(/,\s*/) : [];
        const tid = ensureTrack(cortex, { videoId: String(t.videoId), title: String(t.title || ''), artist: artists.join(', '), artists, album: t.album || '' }, src());
        cortex.link(pid, tid, 'contains', { weight: 1 });
      }
    });
  }

  const get = id => cortex.node.find({ kind: 'playlist', key: key(id) });
  return { library, playlist, get };
}

module.exports = { createPlaylistMirror };
