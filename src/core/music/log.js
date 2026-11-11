// The listening log: one `play` event per finished play in the cortex (W2), local only. The old <data>/music-plays.jsonl is imported once (import.js).
// The extension sends raw facts (how long it was heard, how far it got, how it ended); this module
// turns them into a play with an outcome, so the thresholds can change later without touching the extension.
const { recordPlay, playsFrom } = require('./adapter');

const FINISH_RATIO = 0.85;        // heard at least this much of the track = finished
const SKIP_RATIO = 0.5;           // left before this = skipped
const QUICK_SEC = 30;             // left within this many seconds = a quick skip
const MAX_SEC = 6 * 3600;

const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

// raw extension event → play | null. Pure.
function normalize(e, { now = Date.now() } = {}) {
  if (!e || typeof e !== 'object') return null;
  const videoId = str(e.videoId, 20);
  if (!/^[\w-]{6,20}$/.test(videoId)) return null;
  const at = num(e.startedAt), listened = num(e.listenedMs);
  if (at === null || listened === null || at <= 0 || at > now + 60000 || listened < 1000 || listened > MAX_SEC * 1000) return null;
  const durationSec = num(e.duration) > 0 ? Math.round(num(e.duration)) : null;
  const listenedSec = Math.round(listened / 1000);
  const ratio = durationSec ? Math.min(1, listenedSec / durationSec) : null;
  const reason = ['track-change', 'ended', 'repeat', 'idle', 'closed'].includes(e.reason) ? e.reason : 'closed';
  let outcome = 'unknown';
  if (ratio !== null) outcome = reason === 'ended' || ratio >= FINISH_RATIO ? 'finished' : ratio < SKIP_RATIO && reason !== 'repeat' ? 'skipped' : 'partial';
  const artist = str(e.artist, 120);
  return {
    id: str(e.id, 60) || `${at}-${videoId}`, videoId, title: str(e.title, 160), artist,
    artists: artist ? artist.split(/,\s*/).filter(Boolean) : [], album: str(e.album, 160),
    at, listenedSec, durationSec, ratio: ratio === null ? null : Math.round(ratio * 100) / 100, outcome,
    quickSkip: outcome === 'skipped' && listenedSec < QUICK_SEC, seeks: Math.max(0, Math.min(99, num(e.seeks) || 0)),
    reason, list: str(e.list, 64) || null, liked: e.like === 'LIKE' ? true : e.like === 'DISLIKE' ? false : null,
  };
}

// The play log on the cortex (W2 §3): same surface as the old file log. all() is cached in memory once read (plan E7),
// kept in time order on add, and dropped by trim(). importing is set by the one-time import (music/import.js).
function createPlayLog({ cortex, getConfig = () => ({}), now = Date.now, log = () => {} } = {}) {
  let cache = null;
  const importing = { active: false, pct: 0 };

  // add(rawEvent) → the stored play, or null (logging off, junk, or already stored)
  function add(raw) {
    if (getConfig()?.music?.logPlays === false) return null;
    const p = normalize(raw, { now: now() });
    if (!p) return null;
    let r;
    try { r = recordPlay(cortex, p); } catch (err) { log('play log write failed: ' + err.message); return null; }
    if (!r) return null;
    if (cache) {
      // late events (sent after JARVIS was down) keep time order
      let i = cache.length;
      while (i > 0 && cache[i - 1].at > p.at) i--;
      cache.splice(i, 0, p);
    }
    return p;
  }

  function all() { if (!cache) cache = playsFrom(cortex); return cache; }
  const range = ({ since = null, until = null } = {}) => playsFrom(cortex, { since, until });
  const count = () => cortex.event.count({ kind: 'play' });
  const since = () => cortex.event.query({ kind: 'play', limit: 1 })[0]?.at ?? null;
  function clear() { cortex.event.deleteWhere({ kind: 'play' }); cache = []; }
  function trim() { cache = null; }
  // after an import the cache is stale
  function reload() { cache = null; }

  return { add, clear, all, count, since, range, trim, reload, importing, stats: () => ({ plays: count(), cached: cache ? cache.length : 0 }) };
}

module.exports = { createPlayLog, normalize, FINISH_RATIO, SKIP_RATIO, QUICK_SEC };
