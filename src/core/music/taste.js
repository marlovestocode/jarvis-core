// "Songs you'd like" (W2 §4, plan E12): spreading activation over the user's own play graph. Seeds are the track playing
// now and the top artists by finished plays; activation spreads two hops over `next`, `by` and `contains` with the
// effective (decayed) weights; tracks heard in the last 24 h or mostly skipped are dropped. The model never sees the
// graph: callers get a short list of { videoId, title, artist, why }. An empty graph gives [] (callers fall back).
const { trackKey, artistKey } = require('./adapter');

const DAY = 864e5;
const RECENT_MS = DAY, SKIP_MAX = 0.6, TOP_DAYS = 90, SPREAD_LIMIT = 200;
const ARTIST_SEEDS = [0.6, 0.5, 0.4];
const WHY_RANK = { next: 3, contains: 2, by: 1 };
const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function createTaste({ cortex, playLog, now = Date.now }) {
  // per videoId from the play log: last play time, plays, skips, the newest title/artist
  function playStats(plays) {
    const m = new Map();
    for (const p of plays) {
      let s = m.get(p.videoId);
      if (!s) { s = { last: 0, plays: 0, skips: 0, title: p.title, artist: p.artist, artists: p.artists || [] }; m.set(p.videoId, s); }
      s.plays++; if (p.outcome === 'skipped') s.skips++;
      if (p.at >= s.last) { s.last = p.at; s.title = p.title; s.artist = p.artist; s.artists = p.artists || []; }
    }
    return m;
  }

  function topArtists(plays, t) {
    const n = new Map();
    for (const p of plays) if (p.outcome === 'finished' && p.at >= t - TOP_DAYS * DAY) for (const a of p.artists || []) n.set(a, (n.get(a) || 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).slice(0, ARTIST_SEEDS.length).map(([a]) => a);
  }

  const label = node => (node?.kind === 'track' ? String(node.text).split(' — ')[0] : node?.kind === 'playlist' ? node.data?.name || node.text : String(node?.text || '').replace(/ \(artist\)$/, ''));

  // the reason a path gives: its last edge before the candidate
  function why(n, nodeOf) {
    const via = nodeOf(n.via);
    if (n.type === 'next') return `you often play it after ${label(via)}`;
    if (n.type === 'contains') return `it is in your ${label(via)} playlist`;
    if (n.type === 'by') return `you like ${label(via)}`;
    return 'it is close to what you play';
  }

  function suggest({ n = 5, seeds, exclude = [], artist = null, current = null } = {}) {
    const t = now();
    const plays = playLog.all();
    const stats = playStats(plays);
    const seedList = [];
    if (Array.isArray(seeds) && seeds.length) for (const id of seeds) seedList.push({ id, w: 1 });
    else {
      if (current && (current.title || current.artist)) {
        const ti = norm(current.title), ar = norm(current.artist);
        for (let i = plays.length - 1; i >= 0; i--) {
          const p = plays[i];
          if (norm(p.title) === ti && (!ar || norm(p.artist) === ar || (p.artists || []).some(a => norm(a) === ar))) {
            const id = cortex.node.find({ kind: 'track', key: trackKey(p.videoId) })?.id;
            if (id) seedList.push({ id, w: 1 });
            break;
          }
        }
      }
      topArtists(plays, t).forEach((a, i) => { const id = cortex.node.find({ kind: 'artist', key: artistKey(a) })?.id; if (id) seedList.push({ id, w: ARTIST_SEEDS[i] }); });
    }
    if (!seedList.length) return [];

    const nodes = new Map();
    const nodeOf = id => { if (!nodes.has(id)) nodes.set(id, cortex.node.get(id)); return nodes.get(id); };
    const seedIds = new Set(seedList.map(s => s.id));
    const score = new Map();   // node id → { s, best: { c, n } }
    for (const seed of seedList) {
      for (const nb of cortex.neighbors(seed.id, { types: ['next', 'by', 'contains'], depth: 2, limit: SPREAD_LIMIT })) {
        if (seedIds.has(nb.id)) continue;
        const c = seed.w * nb.weight;
        const cur = score.get(nb.id) || { s: 0, best: null };
        cur.s += c;
        // why: a `next` path says the most (by edges are all weight 1 and would always win), then a playlist, then the artist
        const rank = WHY_RANK[nb.type] ?? 0;
        if (!cur.best || rank > cur.best.rank || (rank === cur.best.rank && c > cur.best.c)) cur.best = { c, rank, n: nb };
        score.set(nb.id, cur);
      }
    }

    const skip = new Set(exclude || []);
    const want = artist ? norm(artist) : null;
    const out = [];
    for (const [id, sc] of [...score].sort((a, b) => b[1].s - a[1].s)) {
      if (out.length >= n) break;
      const node = nodeOf(id);
      if (!node || node.kind !== 'track' || node.status !== 'active') continue;
      const videoId = node.data?.videoId;
      if (!videoId || skip.has(videoId)) continue;
      const st = stats.get(videoId);
      if (st && (t - st.last < RECENT_MS || st.skips / st.plays > SKIP_MAX)) continue;
      const [tTitle, tArtist = ''] = String(node.text).split(' — ');
      const title = st?.title || tTitle, by = st?.artist ?? tArtist;
      if (want && !(st?.artists || by.split(/,\s*/)).some(a => norm(a) === want)) continue;
      out.push({ videoId, title, artist: by, why: why(sc.best.n, nodeOf) });
    }
    return out;
  }

  return { suggest };
}

module.exports = { createTaste };
