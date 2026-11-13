// Lyrics: one place that answers "lyrics for X", "what song goes ...", "what is the line after ...".
// Lyrics come from LRCLIB; Genius only names candidate songs for a remembered line, and a candidate is accepted
// only when the user's words really appear in its lyrics. Nothing is ever filled in from memory.
const { getLyrics } = require('./lrclib');
const { searchByLyric } = require('./genius');
const { found, lineAfter } = require('./match');

const NO_TOKEN = 'Finding a song from its words needs a Genius API token. Put it in genius.token in the JARVIS data folder (or the JARVIS_GENIUS_TOKEN variable), then restart JARVIS.';

// YouTube upload titles are often "Artist - Title" with the uploader as the artist. Try the request as given, then the
// split both ways round (the artist from the title wins over the uploader), each checked by the same strict scoring.
function variants(want) {
  const out = [want];
  const m = String(want.title || '').match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    out.push({ ...want, title: m[2].trim(), artist: m[1].trim() });
    out.push({ ...want, title: m[1].trim(), artist: m[2].trim() });
  }
  return out;
}

function createLyrics({ fetcher, ytm = null, media = null, getToken = () => null, log = () => {} }) {
  // the song playing now: YouTube Music first (it knows album and length), then any Windows media session
  async function current() {
    try {
      const s = ytm?.connected ? await ytm.status() : null;
      const p = s?.playing;
      if (p?.title) return { title: p.title, artist: p.artist || '', album: p.album || '', duration: p.duration || null };
    } catch (err) { log('lyrics: YouTube Music status:', err.message); }
    try {
      const st = await media?.state?.();
      const s = st?.sessions?.find(x => x.status === 'playing') || st?.sessions?.find(x => x.current);
      if (s?.title) return { title: s.title, artist: s.artist || '', album: s.album || '', duration: s.duration || null };
    } catch (err) { log('lyrics: media state:', err.message); }
    return null;
  }

  // req { title, artist? } or { current: true } -> { ok, rec } | { ok: false, reason: 'nothing-playing' | 'not-found' | 'instrumental' | 'error', ... }
  async function get(req) {
    let want = req;
    if (req.current) {
      want = await current();
      if (!want) return { ok: false, reason: 'nothing-playing' };
    }
    let hit;
    try {
      for (const w of variants(want)) { hit = await getLyrics(fetcher, w); if (hit) break; }
    } catch (err) { return { ok: false, reason: 'error', message: err.message, want }; }
    if (!hit) return { ok: false, reason: 'not-found', want };
    if (hit.rec.instrumental && !hit.rec.text) return { ok: false, reason: 'instrumental', want, rec: hit.rec };
    return { ok: true, rec: hit.rec, want };
  }

  // "what song goes <phrase>" -> { ok: true, rec, line, next } | { ok: false, reason: 'no-token' | 'unconfirmed' | 'not-found' | 'error', guess? }
  async function byLyric(phrase) {
    const token = getToken();
    if (!token) return { ok: false, reason: 'no-token', message: NO_TOKEN };
    let cands;
    try { cands = await searchByLyric(fetcher, token, phrase, 5); } catch (err) { return { ok: false, reason: 'error', message: err.message }; }
    if (!cands.length) return { ok: false, reason: 'not-found' };
    const checked = await Promise.all(cands.slice(0, 3).map(async c => { const r = await get({ title: c.title, artist: c.artist }); return { c, r }; }));
    for (const { r } of checked) {
      if (r.ok && found(phrase, r.rec.text)) {
        const at = lineAfter(r.rec.text, phrase);
        return { ok: true, rec: r.rec, line: at?.line || null, next: at?.next || null };
      }
    }
    return { ok: false, reason: 'unconfirmed', guess: cands[0] };
  }

  // "what is the line after <phrase>": the playing song first, then a search by the words
  async function nextLine(phrase) {
    const now = await get({ current: true });
    if (now.ok && found(phrase, now.rec.text)) {
      const at = lineAfter(now.rec.text, phrase);
      if (at) return { ok: true, rec: now.rec, line: at.line, next: at.next };
    }
    return byLyric(phrase);
  }

  return { current, get, byLyric, nextLine };
}

module.exports = { createLyrics, variants, NO_TOKEN };
