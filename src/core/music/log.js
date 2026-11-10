// The listening log: one line per finished play, in <data>/music-plays.jsonl. Local only.
// The extension sends raw facts (how long it was heard, how far it got, how it ended); this module
// turns them into a play with an outcome, so the thresholds can change later without touching the extension.
const fs = require('node:fs');
const path = require('node:path');

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

function createPlayLog({ file, getConfig = () => ({}), now = Date.now, log = () => {} } = {}) {
  const plays = [];
  const ids = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const p = JSON.parse(line); if (p?.id && !ids.has(p.id)) { ids.add(p.id); plays.push(p); } } catch { /* a torn last line: skip it */ }
    }
    plays.sort((a, b) => a.at - b.at);
  } catch { /* no log yet */ }

  // add(rawEvent) → the stored play, or null (logging off, junk, or already stored)
  function add(raw) {
    if (getConfig().music?.logPlays === false) return null;
    const p = normalize(raw, { now: now() });
    if (!p || ids.has(p.id)) return null;
    ids.add(p.id);
    // late events (sent after JARVIS was down) keep time order
    let i = plays.length;
    while (i > 0 && plays[i - 1].at > p.at) i--;
    plays.splice(i, 0, p);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(p) + '\n'); } catch (err) { log('play log write failed: ' + err.message); }
    return p;
  }

  function clear() { plays.length = 0; ids.clear(); try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }

  return { add, clear, all: () => plays, count: () => plays.length, since: () => plays[0]?.at ?? null };
}

module.exports = { createPlayLog, normalize, FINISH_RATIO, SKIP_RATIO, QUICK_SEC };
