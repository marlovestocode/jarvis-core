// YouTube Music through the JARVIS extension: find and play songs, albums and playlists,
// read and change the queue, repeat, shuffle and likes. Every action is checked against
// the tab's real state afterwards (the extension waits for it; this module reads it back).
const { parseRequest, rank, norm } = require('./rank');

const MIN_SCORE = 0.35;      // below this nothing matched well enough to play
const SURE_GAP = 0.15;       // a pick this far ahead of the next distinct song needs no question
const SURE_SCORE = 0.75;     // at or above this the pick is announced in voice only if asked

const by = it => (it.artists?.length ? it.artists.join(', ') : it.artist || '');
const named = (it, quote = true) => {
  const t = quote ? `“${it.title}”` : it.title;
  return by(it) ? `${t} by ${by(it)}` : t;
};
const REPEAT = { none: 'NONE', list: 'ALL', track: 'ONE' };
const REPEAT_WORD = { NONE: 'off', ALL: 'all', ONE: 'this track' };

// resume: optional async () => true when the browser's paused media session was started from outside the page.
// Chrome counts that (Windows media controls, like a hardware play key) as a user action, so it works where the
// page's own player.playVideo() is blocked by the autoplay policy.
function createYtMusic({ link, resume = null }) {
  const call = (cmd, args, timeout) => link.request(cmd, args, timeout ? { timeout } : undefined);

  async function resumeBlocked() {
    if (!resume) return false;
    try { return !!(await resume()); } catch { return false; }
  }

  async function status() {
    const s = await call('status');
    return s?.noTab ? null : s;
  }

  // The YouTube Music tab is what is playing (or nothing else is): queue/repeat/shuffle/like go there.
  async function isSource() {
    if (!link.connected) return false;
    try { const s = await status(); return !!s?.playing; } catch { return false; }
  }

  async function find(text, need) {
    const req = parseRequest(text);
    if (!req.title && !req.artist) return { error: 'What should I play?' };
    const res = await call('search', { query: [req.title, req.artist, req.kind === 'album' ? 'album' : ''].filter(Boolean).join(' ') }, 20000);
    const ranked = rank(req, res?.candidates || [], { need });
    const best = ranked[0];
    if (!best || best.score < MIN_SCORE) return { error: `I couldn't find ${req.title || req.artist} on YouTube Music.` };
    return { req, item: best.c, score: best.score, alts: ranked.slice(1, 3).map(x => x.c) };
  }

  // One real song (not an album, playlist or artist) for adding to a playlist.
  // → { item, score, sure, alts } | { error }. sure = a clear winner; otherwise the caller asks with alts (distinct songs).
  async function findSong(text) {
    const req = { ...parseRequest(text), kind: 'song', mood: false };
    if (!req.title && !req.artist) return { error: 'Which song?' };
    const res = await call('search', { query: [req.title, req.artist].filter(Boolean).join(' ') }, 20000);
    const songs = (res?.candidates || []).filter(c => (c.type === 'song' || c.type === 'video') && c.videoId);
    const ranked = rank(req, songs, { need: 'play' });
    const best = ranked[0];
    if (!best || best.score < MIN_SCORE) return { error: `I couldn't find ${req.title || req.artist} on YouTube Music.`, notFound: true };
    const key = c => `${norm(c.title)}|${norm(by(c))}`;   // the audio and the video of one song are the same song
    const others = ranked.filter(x => key(x.c) !== key(best.c) && x.score >= MIN_SCORE);
    const gap = others.length ? best.score - others[0].score : Infinity;
    const distinct = [];
    for (const x of others) if (!distinct.some(d => key(d) === key(x.c))) distinct.push(x.c);
    return { item: best.c, score: best.score, sure: best.score >= SURE_SCORE && gap >= SURE_GAP, alts: distinct.slice(0, 2) };
  }

  // → { ok, item, sure, started, playing, message }
  async function play(text) {
    const f = await find(text, 'play');
    if (f.error) return { ok: false, message: f.error };
    return playItem(f.item, f.score);
  }

  async function playItem(it, score = 1) {
    const single = it.type === 'song' || it.type === 'video';
    const r = await call('play', { play: it.play, videoId: single ? it.videoId : undefined }, 25000);
    const p = r?.playing;
    if (!p) return { ok: false, item: it, message: "YouTube Music didn't load it." };
    if (single && it.videoId && p.videoId !== it.videoId) return { ok: false, item: it, message: "YouTube Music played something else." };
    if (!r.started && await resumeBlocked()) return { ok: true, item: it, sure: score >= SURE_SCORE, started: true, playing: p };
    if (!r.started) return { ok: true, item: it, started: false, playing: p, message: "It's loaded, but Chrome blocked autoplay. Press play once in the YouTube Music tab." };
    return { ok: true, item: it, sure: score >= SURE_SCORE, started: true, playing: p };
  }

  // "play a random song by X": one real song from X's search results, not a search for a title with the word random in it
  async function playRandom(artist) {
    const res = await call('search', { query: String(artist || '').trim() + ' songs' }, 20000);
    const songs = (res?.candidates || []).filter(c => (c.type === 'song' || c.type === 'video') && c.videoId);
    if (!songs.length) return { ok: false, message: `I couldn't find songs for ${artist} on YouTube Music.` };
    return playItem(songs[Math.floor(Math.random() * songs.length)]);
  }

  // add one found item to the queue and check the tab's queue really has it
  async function enqueueItem(item, position) {
    const target = item.queue?.[position] || item.queue?.end || item.queue?.next;
    if (!target) return { ok: false, item, message: "YouTube Music can't queue that." };
    const r = await call('enqueue', { target, position }, 20000);
    if (r?.started) return { ok: true, item, started: true };
    const q = r?.queue;
    const id = target.videoId;
    const landed = !id || q?.items?.some(x => x.videoId === id);
    if (!landed) return { ok: false, item, message: "The queue didn't change." };
    return { ok: true, item, position, added: r.added };
  }

  async function enqueue(text, position) {
    const f = await find(text, position);
    if (f.error) return { ok: false, message: f.error };
    const r = await enqueueItem(f.item, position);
    return r.ok ? { ...r, item: f.item } : r;
  }

  // "queue 5 random songs by X": real songs from X's search results, shuffled, no repeats, each checked in the queue.
  // → { ok, added: [item], failed: n } | { ok: false, message }
  async function queueRandom(artist, count = 5, position = 'end') {
    const want = Math.max(1, Math.min(10, Math.round(Number(count)) || 5));
    const res = await call('search', { query: String(artist || '').trim() + ' songs' }, 20000);
    const seen = new Set();
    const songs = (res?.candidates || []).filter(c => (c.type === 'song' || c.type === 'video') && c.videoId && !seen.has(norm(c.title)) && seen.add(norm(c.title)));
    if (!songs.length) return { ok: false, message: `I couldn't find songs for ${artist} on YouTube Music.` };
    for (let i = songs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [songs[i], songs[j]] = [songs[j], songs[i]]; }
    const added = [];
    let failed = 0;
    for (const song of songs) {
      if (added.length >= want) break;
      const r = await enqueueItem(song, position);
      if (r.ok) added.push(song); else failed++;
    }
    return added.length ? { ok: true, added, failed } : { ok: false, message: "None of them could be queued." };
  }

  async function upNext(count = 3) {
    const s = await status();
    if (!s?.queue) return { none: true };
    const q = s.queue;
    const after = [...q.items.slice(q.index + 1), ...(q.items.length - q.index - 1 < count ? q.automix : [])].slice(0, count);
    return { now: s.playing, next: after, repeat: q.repeat };
  }

  async function removeNext() {
    const s = await status();
    if (!s?.queue || s.queue.index + 1 >= s.queue.items.length) return { ok: false, message: 'Nothing is queued after this song.' };
    const r = await call('remove', { index: s.queue.index + 1 });
    return { ok: true, removed: r.removed };
  }

  async function clear() {
    const r = await call('clear');
    return { ok: true, removed: r.removed };
  }

  async function repeat(mode) {
    const r = await call('repeat', { mode: REPEAT[mode] || 'ONE' });
    return { ok: true, value: REPEAT_WORD[r.repeat] };
  }

  async function shuffle() {
    const r = await call('shuffle');
    return r.shuffled ? { ok: true } : { ok: false, message: 'There is nothing in the queue to shuffle.' };
  }

  async function like(value) {
    const r = await call('like', { value });
    return { ok: true, value: r.like };
  }

  return { get connected() { return link.connected; }, status, isSource, find, findSong, play, enqueue, enqueueItem, queueRandom, playRandom, playItem, resumeBlocked, upNext, removeNext, clear, repeat, shuffle, like, named };
}

module.exports = { createYtMusic, named };
