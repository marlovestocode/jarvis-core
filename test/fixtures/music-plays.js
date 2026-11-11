// A deterministic listening log in the shape of the real <data>/music-plays.jsonl: raw extension events passed
// through music/log.js normalize(), so every field (outcome, quickSkip, artists, list, liked) is what the app writes.
const { normalize } = require('../../src/core/music/log');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

// raw events (what the extension sends), in arrival order
function makeEvents({ n = 600, seed = 7, start = Date.UTC(2026, 6, 1, 18), tracks: nTracks = 150 } = {}) {
  const r = rng(seed);
  const artists = Array.from({ length: 40 }, (_, i) => (i % 9 === 3 ? `Artist ${i}, Guest ${i % 4}` : i === 5 ? 'U2' : `Artist ${i}`));
  const tracks = Array.from({ length: nTracks }, (_, i) => ({
    videoId: ('vid' + i.toString(36)).padEnd(11, 'x'), title: i === 7 ? 'Secret' : `Song ${i}`,
    artist: artists[Math.floor(Math.pow(r(), 1.6) * artists.length)], album: i % 3 ? `Album ${i % 20}` : '', duration: 120 + Math.floor(r() * 240),
  }));
  const lists = [null, null, 'PLgym', 'PLchill', 'RDAMVM'];
  const out = [];
  let t = start;
  for (let i = 0; i < n; i++) {
    if (r() < 0.12) t += (1 + Math.floor(r() * 40)) * 3600e3;          // a new session hours later
    const tr = tracks[Math.floor(Math.pow(r(), 1.4) * tracks.length)];
    const k = r();
    const listened = k < 0.6 ? tr.duration : k < 0.75 ? 5 + Math.floor(r() * 20) : k < 0.85 ? 40 + Math.floor(r() * 30) : Math.floor(tr.duration * (0.5 + r() * 0.3));
    const reason = listened >= tr.duration ? 'ended' : r() < 0.05 ? 'repeat' : 'track-change';
    out.push({ id: `${t}-${tr.videoId}`, videoId: tr.videoId, title: tr.title, artist: tr.artist, album: tr.album, startedAt: t, endedAt: t + listened * 1000,
      listenedMs: listened * 1000, duration: r() < 0.03 ? 0 : tr.duration, seeks: r() < 0.1 ? 1 : 0, reason, list: lists[Math.floor(r() * lists.length)],
      like: r() < 0.05 ? 'LIKE' : r() < 0.02 ? 'DISLIKE' : null });
    t += listened * 1000 + Math.floor(r() * 20000);
  }
  // one late event: sent after a restart, older than the ones before it
  out.push({ ...out[10], id: undefined, startedAt: out[10].startedAt - 3 * 3600e3, endedAt: undefined });
  out.at(-1).id = `${out.at(-1).startedAt}-${out.at(-1).videoId}`;
  return out;
}

const makePlays = opts => makeEvents(opts).map(e => normalize(e, { now: Date.UTC(2030, 0, 1) })).filter(Boolean);

module.exports = { makeEvents, makePlays };

// the golden set: every stats report over three periods, as music_stats asks for them
const GOLDEN_NOW = Date.UTC(2026, 8, 1, 12);
function goldenCases(all, report, REPORTS) {
  const top = report(all, { report: 'top_artists', period: 'all', now: GOLDEN_NOW, limit: 1 }).data?.[0]?.name || 'Artist 0';
  const out = [];
  for (const name of REPORTS) for (const period of ['all', 'week', '30']) {
    out.push({ name: `${name}/${period}`, text: report(all, { report: name, period, now: GOLDEN_NOW, limit: 10, by: 'plays', name: top, names: id => (id === 'PLgym' ? 'Gym' : null) }).text });
  }
  return out;
}

module.exports.goldenCases = goldenCases;
module.exports.GOLDEN_NOW = GOLDEN_NOW;
