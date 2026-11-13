// LRCLIB (https://lrclib.net): free lyrics by title, artist, album and duration. No key.
// Everything goes through the allowlisted fetcher (source "lyrics"), cached on disk for 30 days.
const { cleanTitle, pickBest, norm } = require('./match');

const BASE = 'https://lrclib.net/api';
const TTL_MS = 30 * 24 * 3600 * 1000;
const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const STOP = new Set(['the', 'and', 'for', 'two', 'too', 'you', 'your', 'with', 'from', 'that', 'this', 'are', 'was', 'not', 'but', 'its', 'all', 'end', 'one']);
const is404 =err => /HTTP 404/.test(err?.message || '');

// plain text from a record: plainLyrics, else syncedLyrics with its [mm:ss.xx] stamps removed
function toPlain(r) {
  if (r.plainLyrics) return String(r.plainLyrics);
  if (r.syncedLyrics) return String(r.syncedLyrics).split(/\r?\n/).map(l => l.replace(/^(?:\[[^\]]*\]\s*)+/, '')).join('\n');
  return '';
}

const shape = r => ({ id: r.id, title: r.trackName || '', artist: r.artistName || '', album: r.albumName || '', duration: Number(r.duration) || null, instrumental: !!r.instrumental, text: toPlain(r).replace(/\r/g, '').trim() });

async function json(fetcher, url) {
  try { return (await fetcher.getJson('lyrics', url, { ttlMs: TTL_MS })).data; } catch (err) { if (is404(err)) return null; throw err; }
}

// req { title, artist?, album?, duration? } -> { rec, score } | null
async function getLyrics(fetcher, req) {
  const title = String(req.title || '').trim();
  if (!title) return null;
  if (title && req.artist && req.album && req.duration) {
    const r = await json(fetcher, `${BASE}/get?${qs({ track_name: title, artist_name: req.artist, album_name: req.album, duration: Math.round(req.duration) })}`);
    const hit = r?.id ? pickBest(req, [shape(r)]) : null;
    if (hit) return hit;
  }
  const clean = cleanTitle(title) || title;
  // strict field search first, then free text with the artist, then the title alone (an artist spelled differently, like
  // "Suicide Boys" for "$uicideboy$", finds nothing in the first two; scoring picks the right record from the third)
  const queries = [qs({ track_name: clean, artist_name: req.artist }), qs({ q: [clean, req.artist].filter(Boolean).join(' ') })];
  if (req.artist) {
    // its search is literal: "Suicide Boys" finds nothing for "$uicideboy$", so also try the name run together and with
    // the first and last s written as a dollar sign, then the title alone
    const together = norm(req.artist).replace(/ /g, '');
    const styled = together.replace(/^s/, '$$').replace(/s$/, '$$');
    for (const v of [together, styled]) if (v && v !== req.artist.toLowerCase()) queries.push(qs({ q: `${clean} ${v}` }));
    queries.push(qs({ q: clean }));
  }
  // Speech-to-text garbles titles ("end those two i love" for "...And To Those I Love"), and the search needs every word to
  // match. So also search the content words alone, then just the last or first three; scoring still decides what counts.
  const key = norm(clean).split(' ').filter(w => w.length >= 3 && !STOP.has(w));
  if (key.length >= 2) {
    const tries = new Set([key.join(' '), key.slice(-3).join(' '), key.slice(0, 3).join(' ')]);
    for (const k of tries) if (k !== norm(clean)) queries.push(qs({ q: k }));
  }
  for (const q of queries) {
    const list = await json(fetcher, `${BASE}/search?${q}`);
    const hit = pickBest(req, (Array.isArray(list) ? list : []).map(shape));
    if (hit) return hit;
  }
  return null;
}

module.exports = { getLyrics, toPlain };
