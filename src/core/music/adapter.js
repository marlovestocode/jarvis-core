// Plays on the cortex (W2 §2): each finished play is an event `play` (payload = the normalize() object) on its
// `track` node; tracks link `by` their artists; consecutive plays in one listening session build `next` edges,
// strengthened by a finished transition and weakened by a quick skip (plan E8). Only cortex verbs, no SQL.
const SESSION_GAP = 30 * 60 * 1000;   // stats.js sessions: end of one play to the start of the next
const ETA_NEXT = 0.15, SKIP_FACTOR = 0.6;

const trackKey = videoId => 'track:' + videoId;
const artistKey = name => 'artist:' + String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const atLeast3 = (s, suffix) => (s.length >= 3 ? s : `${s} ${suffix}`);   // node text has a 3-char floor (E19)

function trackText(p) {
  const title = String(p.title || '').trim(), artist = String(p.artist || '').trim();
  if (!title) return p.videoId;
  return atLeast3(artist ? `${title} — ${artist}` : title, '(track)').slice(0, 300);
}

// the tool source for everything the extension reports, one row reused
function musicSource(cortex) {
  return cortex.source.find({ kind: 'tool', ref: 'youtube-music' }) ?? cortex.source.add({ kind: 'tool', ref: 'youtube-music', title: 'YouTube Music extension' });
}

// a track node, created with its artist links the first time it is seen; later plays keep the first title
function ensureTrack(cortex, p, source) {
  const found = cortex.node.find({ kind: 'track', key: trackKey(p.videoId) });
  if (found) return found.id;
  const data = { videoId: p.videoId };
  if (p.album) data.album = String(p.album).slice(0, 160);
  const id = cortex.node.upsert({ kind: 'track', key: trackKey(p.videoId), text: trackText(p), data, source }).id;
  for (const name of (p.artists || []).slice(0, 5)) {
    const key = artistKey(name);
    if (key === 'artist:') continue;
    const a = cortex.node.find({ kind: 'artist', key })?.id ?? cortex.node.upsert({ kind: 'artist', key, text: atLeast3(String(name).trim(), '(artist)').slice(0, 300), source }).id;
    cortex.link(id, a, 'by', { weight: 1 });
  }
  return id;
}

// p1 → p2 in one session (E8): finished strengthens, a quick skip weakens that one edge, anything else leaves it
function transition(cortex, prev, prevId, p, id) {
  if (!prev || prevId === undefined || prevId === id) return;
  if (p.at - (prev.at + (prev.listenedSec || 0) * 1000) > SESSION_GAP || p.at < prev.at) return;
  if (p.outcome === 'finished') cortex.link(prevId, id, 'next', { eta: ETA_NEXT });
  else if (p.quickSkip) cortex.scaleEdge(prevId, id, 'next', SKIP_FACTOR);
}

// one play → event + nodes + next, in one transaction. prev: the play before it (undefined = look it up), null = none.
// → { eventId, trackId } | null when the same track already has a play at that moment (a re-sent event, E6)
function recordPlay(cortex, p, { prev, source = musicSource(cortex) } = {}) {
  return cortex.transaction(() => {
    const existing = cortex.node.find({ kind: 'track', key: trackKey(p.videoId) });
    if (existing && cortex.event.query({ kind: 'play', nodeId: existing.id, since: p.at, until: p.at + 1, limit: 1 }).length) return null;
    const before = prev !== undefined ? prev : cortex.event.query({ kind: 'play', until: p.at, order: 'desc', limit: 1 })[0]?.payload || null;
    const trackId = existing ? existing.id : ensureTrack(cortex, p, source);
    const eventId = cortex.event.add({ kind: 'play', nodeId: trackId, payload: p, at: p.at });
    if (before) transition(cortex, before, cortex.node.find({ kind: 'track', key: trackKey(before.videoId) })?.id, p, trackId);
    return { eventId, trackId };
  });
}

// the plays as stats.js wants them, ordered by `at`
const playsFrom = (cortex, { since = null, until = null } = {}) => cortex.event.query({ kind: 'play', since, until, limit: 1e6 }).map(e => e.payload);

module.exports = { recordPlay, playsFrom, musicSource, trackKey, artistKey, trackText, SESSION_GAP, ETA_NEXT, SKIP_FACTOR };
