// Genius official API: search only. Its search matches lyric snippets and returns the song (title, artist, page URL);
// it never returns lyrics, and JARVIS never reads lyrics from Genius pages. The client access token goes only to
// api.genius.com, in an Authorization header (never in the URL, so it is not in the cache key or any log).
const fs = require('node:fs');

const SEARCH = 'https://api.genius.com/search';
const TTL_MS = 7 * 24 * 3600 * 1000;

// env JARVIS_GENIUS_TOKEN, else the first line of <data>/genius.token
function loadToken(dataDir, env = process.env) {
  const e = String(env.JARVIS_GENIUS_TOKEN || '').trim();
  if (e) return e;
  try { return fs.readFileSync(`${dataDir}/genius.token`, 'utf8').split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

// -> [{ title, artist }] best first, no repeats
async function searchByLyric(fetcher, token, phrase, limit = 5) {
  const r = await fetcher.getJson('lyrics', `${SEARCH}?q=${encodeURIComponent(String(phrase).trim().slice(0, 200))}`, { ttlMs: TTL_MS, headers: { Authorization: `Bearer ${token}` } });
  const seen = new Set(), out = [];
  for (const h of r.data?.response?.hits || []) {
    const x = h?.result;
    if (!x || h.type !== 'song' || !x.title) continue;
    const artist = x.primary_artist?.name || '';
    const key = `${x.title}|${artist}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: x.title, artist });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { searchByLyric, loadToken };
