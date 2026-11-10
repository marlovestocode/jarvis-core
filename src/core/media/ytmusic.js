// YouTube Music through the JARVIS extension: find and play songs, albums and playlists,
// read and change the queue, repeat, shuffle and likes. Every action is checked against
// the tab's real state afterwards (the extension waits for it; this module reads it back).
const { parseRequest, rank } = require('./rank');

const MIN_SCORE = 0.35;      // below this nothing matched well enough to play
const SURE_SCORE = 0.75;     // at or above this the pick is announced in voice only if asked

const by = it => (it.artists?.length ? it.artists.join(', ') : it.artist || '');
const named = (it, quote = true) => {
  const t = quote ? `“${it.title}”` : it.title;
  return by(it) ? `${t} by ${by(it)}` : t;
};
const REPEAT = { none: 'NONE', list: 'ALL', track: 'ONE' };
const REPEAT_WORD = { NONE: 'off', ALL: 'all', ONE: 'this track' };

function createYtMusic({ link }) {
  const call = (cmd, args, timeout) => link.request(cmd, args, timeout ? { timeout } : undefined);

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

  // → { ok, item, sure, started, playing, message }
  async function play(text) {
    const f = await find(text, 'play');
    if (f.error) return { ok: false, message: f.error };
    const it = f.item;
    const single = it.type === 'song' || it.type === 'video';
    const r = await call('play', { play: it.play, videoId: single ? it.videoId : undefined }, 25000);
    const p = r?.playing;
    if (!p) return { ok: false, item: it, message: "YouTube Music didn't load it." };
    if (single && it.videoId && p.videoId !== it.videoId) return { ok: false, item: it, message: "YouTube Music played something else." };
    if (!r.started) return { ok: true, item: it, started: false, playing: p, message: "It's loaded, but Chrome blocked autoplay. Press play once in the YouTube Music tab." };
    return { ok: true, item: it, sure: f.score >= SURE_SCORE, started: true, playing: p };
  }

  async function enqueue(text, position) {
    const f = await find(text, position);
    if (f.error) return { ok: false, message: f.error };
    const target = f.item.queue?.[position] || f.item.queue?.end || f.item.queue?.next;
    const r = await call('enqueue', { target, position }, 20000);
    if (r?.started) return { ok: true, item: f.item, started: true };
    const q = r?.queue;
    const id = target.videoId;
    const landed = !id || q?.items?.some(x => x.videoId === id);
    if (!landed) return { ok: false, item: f.item, message: "The queue didn't change." };
    return { ok: true, item: f.item, position, added: r.added };
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

  return { get connected() { return link.connected; }, status, isSource, find, play, enqueue, upNext, removeNext, clear, repeat, shuffle, like, named };
}

module.exports = { createYtMusic, named };
