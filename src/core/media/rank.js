// Pick the search result the user meant. Pure; tested in test/ytmusic.test.js.
// parseRequest("bohemian rhapsody by queen") → { title, artist, kind, mood }
// rank(request, candidates, { need }) → [{ c, score }] best first (need: 'play' | 'next' | 'end').

const VARIANTS = ['live', 'cover', 'remix', 'karaoke', 'instrumental', 'acoustic', 'sped up', 'slowed', 'nightcore', '8d', 'reverb', 'piano version', 'tribute', 'lofi', 'lo fi', 'mashup', 'parody', 'reaction', 'tutorial', 'lyrics'];
const KIND_WORDS = [[/\b(?:the )?album\b/, 'album'], [/\b(?:the )?playlist\b/, 'playlist'], [/\b(?:the )?(?:music )?video\b/, 'video'], [/\b(?:the )?(?:song|track)\b/, 'song'], [/\b(?:the )?(?:podcast|episode)\b/, 'episode']];
const MOOD = /^(?:some|a bit of|a little|any)\b|\b(?:music|songs|playlist|mix|radio|vibes|beats|hits)$/;

function norm(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\$/g, 's').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
const tokens = s => norm(s).split(' ').filter(Boolean);
const STOP = new Set(['the', 'a', 'an', 'of', 'by', 'feat', 'ft', 'featuring', 'official', 'audio', 'video', 'music', 'hd', 'hq', 'version', 'remastered', 'remaster']);
const content = s => tokens(s).filter(t => !STOP.has(t));

// Speech-to-text and spelling drift ("mornin'" vs "morning", "suicide boys" vs "suicideboys")
// must not stop a match, so tokens compare fuzzily instead of exactly.
function lev(a, b) {
  const p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = p[0]; p[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = p[j];
      p[j] = Math.min(p[j] + 1, p[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return p[b.length];
}
const strSim = (a, b) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length));
const NUM = /^\d+$/;
function tokSim(a, b) {
  if (a === b) return 1;
  if (NUM.test(a) || NUM.test(b)) return 0;   // "5" is not "15"
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let sim = strSim(a, b);
  if (l.length - s.length <= 2 && (l.startsWith(s) || l.endsWith(s))) sim = Math.max(sim, 0.8);   // "n" / "in", "mornin" / "morning"
  return sim >= 0.7 ? sim : 0;
}
// Best one-to-one pairing of tokens (greedy); returns the summed similarity.
function softMatch(a, b) {
  const used = new Set();
  let sum = 0;
  for (const t of a) {
    let best = 0, at = -1;
    b.forEach((u, i) => { if (used.has(i)) return; const s = tokSim(t, u); if (s > best) { best = s; at = i; } });
    if (at >= 0) { used.add(at); sum += best; }
  }
  return sum;
}
const compactSim = (a, b) => { const x = a.join(''), y = b.join(''); return x && y && x.length >= 4 && y.length >= 4 ? Math.max(0, strSim(x, y) - 0.1) / 0.9 : 0; };

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const A = [...new Set(a)], B = [...new Set(b)];
  const soft = (2 * softMatch(A, B)) / (A.length + B.length);
  return Math.min(1, Math.max(soft, compactSim(A, B) >= 0.85 ? compactSim(A, B) : 0));
}
function coverage(q, have) {
  if (!q.length) return 0;
  const soft = softMatch(q, have) / q.length;
  return Math.min(1, Math.max(soft, compactSim(q, have) >= 0.85 ? compactSim(q, have) : 0));
}

function parseRequest(text) {
  let t = norm(text).replace(/^(?:play|put on|queue up|queue|start playing|add)\s+/, '').replace(/\s+(?:on|in|from) (?:youtube music|youtube|yt music)$/, '');
  let kind = null;
  for (const [re, k] of KIND_WORDS) if (re.test(t)) { kind = k; t = t.replace(re, ' ').replace(/\s+/g, ' ').trim(); break; }
  const mood = MOOD.test(t) && !/\bby\b/.test(t);
  t = t.replace(/^(?:some|a bit of|a little|any)\s+/, '');
  let title = t, artist = '';
  const m = t.match(/^(.+?)\s+by\s+(.+)$/);
  if (m) { title = m[1]; artist = m[2]; }
  if (/^(?:songs?|music|something|stuff|anything)$/.test(title) && artist) { title = ''; }   // "songs by queen"
  return { title: title.trim(), artist: artist.trim(), kind, mood, query: t.replace(/\s+by\s+/, ' ') };
}

function score(req, c, i) {
  const ct = content(c.title), ca = content((c.artists || []).join(' '));
  const qt = content(req.title), qa = content(req.artist), qall = content(req.query);
  let s;
  if (!req.title && req.artist) s = 0.9 * dice(qa, ca) + 0.1 * coverage(qa, ct);               // "songs by queen"
  else if (req.artist) s = 0.6 * dice(qt, ct) + 0.4 * Math.max(dice(qa, ca), coverage(qa, ca));
  else s = 0.55 * dice(qt, ct) + 0.45 * coverage(qall, [...ct, ...ca]);
  if (req.title && norm(c.title) === norm(req.title)) s += 0.15;

  const want = req.kind || (req.mood ? 'mood' : !req.title && req.artist ? 'artist-mix' : 'song');
  const type = c.type;
  if (want === 'song') s += { song: 0.1, video: 0.04, album: -0.15, playlist: -0.15, artist: -0.25 }[type] ?? -0.3;
  else if (want === 'mood') s += { playlist: 0.2, other: 0.2, album: 0.05, song: 0, video: -0.05, artist: -0.1 }[type] ?? -0.2;
  else if (want === 'artist-mix') s += { artist: 0.25, playlist: 0.15, other: 0.1, song: 0.05, video: 0 }[type] ?? -0.1;
  else s += type === want ? 0.25 : -0.3;

  const title = ` ${norm(c.title)} `, asked = ` ${norm(req.query)} `;
  if (VARIANTS.some(v => title.includes(` ${v} `) && !asked.includes(` ${v} `))) s -= 0.25;
  if (c.top) s += 0.05;
  return s - i * 0.004;
}

function rank(req, candidates, { need = 'play' } = {}) {
  const usable = c => (need === 'play' ? !!c.play : !!(c.queue?.[need] || c.queue?.end || c.queue?.next));
  return candidates.map((c, i) => ({ c, score: usable(c) ? score(req, c, i) : -Infinity }))
    .filter(x => x.score > -Infinity).sort((a, b) => b.score - a.score);
}

// How well a spoken name matches a title (0..1): exact = 1, otherwise token coverage and overlap.
// Used to find the user's own playlists by name.
function matchText(query, title) {
  const q = norm(query), t = norm(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const qt = content(query), tt = content(title);
  const a = qt.length ? qt : tokens(query), b = tt.length ? tt : tokens(title);
  let s = 0.6 * coverage(a, b) + 0.4 * dice(a, b);
  if (` ${t} `.includes(` ${q} `)) s = Math.max(s, 0.85);
  return Math.min(s, 0.99);
}

module.exports = { parseRequest, rank, norm, matchText };
