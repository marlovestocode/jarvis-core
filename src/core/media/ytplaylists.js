// The user's YouTube Music playlists through the extension: live library and track lists with a TTL cache,
// name resolution against that real data, and a short digest for the prompt.
// Data comes from the extension commands `playlists` and `playlist` (extension/page.js); nothing here is hardcoded.
// Phase 1 (read only). Edits, undo and confirmation arrive in later phases (docs/superpowers/plans/2026-11-10-ytm-playlists.md).
const fs = require('node:fs');
const path = require('node:path');
const { matchText, norm, parseRequest } = require('./rank');
const { memoryJournal } = require('./ytjournal');

const MIN_EXTENSION = '1.1.0';
const MIN_FOR = { playlist_edit: '1.2.0' };   // commands added after 1.1.0
const DEFAULT_MUSIC = Object.freeze({ aliases: [], libraryTtlSec: 300, playlistTtlSec: 120, digestSize: 30, maxBulk: 25 });
const JOURNAL_MAX = 20;                // edits that can still be undone
const FRESH_MS = 10000;                // a playlist read newer than this is trusted for duplicate checks
const MIN_GAP_MS = 100;            // between extension calls: be gentle with the API
const MAX_RETRIES = 2;             // on a rate limit
const MAX_TRACKS = 5000;           // YouTube Music's own playlist limit

// resolver thresholds (scores come from rank.matchText, 0..1)
const OK_SCORE = 0.6;              // at or above this (and clearly ahead) the playlist is the one meant
const GAP = 0.1;                   // how far ahead of the runner-up it must be
const MAYBE_SCORE = 0.4;           // below this nothing matches
const NEAR_SCORE = 0.2;            // "did you mean" suggestions

const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return true; };
const fail = (code, message) => Object.assign(new Error(message), { code });
const delay = ms => new Promise(r => setTimeout(r, ms));

// "my gym playlist" → "gym"; "liked songs" is how people say the Liked Music playlist
function cleanName(text) {
  const n = norm(text).replace(/^(?:my|the)\s+/, '').replace(/\s+(?:playlist|list)$/, '').trim() || norm(text);
  return /^liked (?:songs|tracks|music)$/.test(n) ? 'liked music' : n;
}

const ORDINALS = [[/^(?:1|one|first|1st)\b/, 0], [/^(?:2|two|second|2nd)\b/, 1], [/^(?:3|three|third|3rd)\b/, 2]];
const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|correct|right|that one|that's it|do it|please)\b/;

// journal: where the undo journal lives (ytjournal.js; the cortex in the app). mirror: the cortex copy of the playlists
// (mirror.js), told about fresh reads only; its errors are logged, never thrown.
function createYtPlaylists({ link, ytm = null, getConfig = () => ({}), now = Date.now, sleep = delay, file = null, journal: journalStore = memoryJournal(), mirror = null, log = () => {} }) {
  const cfg = () => ({ ...DEFAULT_MUSIC, ...(getConfig()?.music || {}) });
  let library = { at: 0, list: [] };        // at = 0 means "hint from disk or never fetched": refetch before use
  const tracks = new Map();                  // playlist id → { at, data }
  let tail = Promise.resolve();              // one extension call at a time
  let lastCall = 0;

  if (file) {
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(d.playlists)) library = { at: 0, list: d.playlists }; } catch { /* no hint yet */ }
  }
  function persist() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify({ at: library.at, playlists: library.list })); fs.renameSync(file + '.tmp', file); } catch (err) { log('ytplaylists: could not save the library hint:', err.message); }
  }

  // ---- calls to the extension: serialized, spaced, retried on a rate limit, errors with a code ----
  async function once(cmd, args, timeout) {
    if (!link.connected) throw fail('NO_LINK', 'The YouTube Music extension is not connected');
    const v = link.info?.version;
    if (v && !newer(v, MIN_FOR[cmd] || MIN_EXTENSION)) throw fail('OLD', 'The YouTube Music extension is out of date: reload it in chrome://extensions');
    const wait = lastCall + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    try {
      return await link.request(cmd, args, timeout ? { timeout } : undefined);
    } catch (err) {
      const m = /^(AUTH|RATE):\s*(.*)$/s.exec(err?.message || '');
      if (m) throw fail(m[1], m[1] === 'AUTH' ? 'Sign in to YouTube Music in Chrome first' : m[2]);
      // an extension from before this feature does not know the command (its version can still look current)
      if (/^Unknown command/.test(err?.message || '')) throw fail('OLD', 'The YouTube Music extension is out of date: reload it in chrome://extensions');
      throw err;
    } finally { lastCall = now(); }
  }
  function call(cmd, args, timeout) {
    const run = async () => {
      for (let n = 0; ; n++) {
        try { return await once(cmd, args, timeout); } catch (err) {
          if (err.code !== 'RATE' || n >= MAX_RETRIES) throw err;
          await sleep(800 * 2 ** n);
        }
      }
    };
    const p = tail.then(run, run);
    tail = p.catch(() => {});
    return p;
  }

  function mirrored(fn) { if (!mirror) return; try { fn(); } catch (err) { log('ytplaylists: playlist mirror:', err.message); } }

  // ---- library ----
  async function getLibrary({ refresh = false } = {}) {
    const ttl = cfg().libraryTtlSec * 1000;
    if (!refresh && library.at && now() - library.at < ttl) return { playlists: library.list, at: library.at, stale: false };
    try {
      const r = await call('playlists', {}, 30000);
      if (r?.noTab) throw fail('NO_TAB', 'The YouTube Music extension did not open a tab, so it is probably out of date: reload it in chrome://extensions');
      library = { at: now(), list: Array.isArray(r?.playlists) ? r.playlists : [] };
      persist();
      if (Array.isArray(r?.playlists)) mirrored(() => mirror.library(library.list));   // a garbled read never reaches the mirror
      return { playlists: library.list, at: library.at, stale: false };
    } catch (err) {
      if (err.code === 'AUTH') throw err;   // never present old data as current when the account is signed out
      if (library.list.length) return { playlists: library.list, at: library.at, stale: true, error: err.message };
      throw err;
    }
  }

  // ---- name resolution ----
  // → { status: 'ok', playlist } | { status: 'ambiguous', candidates } | { status: 'notFound', near }
  async function resolve(text, { refresh = false, editableOnly = false } = {}) {
    const raw = String(text || '').trim();
    if (!raw) return { status: 'notFound', near: [] };
    const { playlists } = await getLibrary({ refresh });
    const pool = editableOnly ? playlists.filter(p => p.editable) : playlists;

    const byId = pool.find(p => p.id === raw);
    if (byId) return { status: 'ok', playlist: byId };

    const q = cleanName(raw);
    const aliases = Array.isArray(cfg().aliases) ? cfg().aliases : [];
    const alias = aliases.find(a => norm(a.alias) === q);
    const viaAlias = alias && pool.find(p => p.id === alias.playlistId);
    if (viaAlias) return { status: 'ok', playlist: viaAlias };

    const exact = pool.filter(p => norm(p.title) === q || norm(p.title) === norm(raw));
    if (exact.length === 1) return { status: 'ok', playlist: exact[0] };
    if (exact.length > 1) return { status: 'ambiguous', candidates: exact.slice(0, 3) };

    const scored = pool.map(p => ({ p, s: matchText(q, p.title) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    const [top, next] = scored;
    if (top && top.s >= OK_SCORE && (!next || top.s - next.s >= GAP)) return { status: 'ok', playlist: top.p };
    if (top && top.s >= MAYBE_SCORE) return { status: 'ambiguous', candidates: scored.filter(x => top.s - x.s < 0.15 && x.s >= MAYBE_SCORE).slice(0, 3).map(x => x.p) };
    return { status: 'notFound', near: scored.filter(x => x.s >= NEAR_SCORE).slice(0, 3).map(x => x.p) };
  }

  // ---- one playlist's tracks ----
  async function getPlaylist(meta, { refresh = false, maxAgeMs } = {}) {
    const hit = tracks.get(meta.id);
    if (!refresh && hit && now() - hit.at < (maxAgeMs ?? cfg().playlistTtlSec * 1000)) return { ...hit.data, at: hit.at, cached: true };
    const r = await call('playlist', { id: meta.id, limit: MAX_TRACKS }, 60000);
    if (r?.noTab) throw fail('NO_TAB', 'The YouTube Music extension did not open a tab, so it is probably out of date: reload it in chrome://extensions');
    const data = {
      id: meta.id, title: meta.title || r.title, kind: meta.kind || null,
      editable: typeof meta.editable === 'boolean' ? meta.editable : !!r.editable,
      truncated: !!r.truncated, tracks: Array.isArray(r.tracks) ? r.tracks : [],
    };
    tracks.set(meta.id, { at: now(), data });
    if (Array.isArray(r.tracks)) mirrored(() => mirror.playlist(data));
    return { ...data, at: now(), cached: false };
  }

  // a name or id → { status, ...playlist data } (fetches the tracks only when the name settles to one playlist)
  async function open(text, opts = {}) {
    const r = await resolve(text, opts);
    if (r.status !== 'ok') return r;
    return { status: 'ok', ...(await getPlaylist(r.playlist, opts)) };
  }

  // ---- which song of a playlist did the user mean ("lose yourself", "stronger by kanye west") ----
  function findTrack(list, text) {
    const req = parseRequest(text);
    const title = req.title || norm(text), artist = req.artist;
    const scored = list.map((t, i) => {
      const byTitle = matchText(title, t.title);
      const s = artist ? 0.6 * byTitle + 0.4 * matchText(artist, (t.artists || []).join(' ')) : Math.max(byTitle, 0.85 * matchText(title, `${t.title} ${(t.artists || []).join(' ')}`));
      return { t, i, s };
    }).filter(x => x.s > 0 && x.t.available !== false).sort((a, b) => b.s - a.s);
    const [top, next] = scored;
    if (top && top.s >= OK_SCORE && (!next || top.s - next.s >= GAP || next.t.videoId === top.t.videoId)) return { status: 'ok', track: top.t, index: top.i };
    if (top && top.s >= MAYBE_SCORE) return { status: 'ambiguous', candidates: scored.filter(x => top.s - x.s < 0.15 && x.s >= MAYBE_SCORE).slice(0, 3).map(x => x.t) };
    return { status: 'notFound', near: scored.filter(x => x.s >= NEAR_SCORE).slice(0, 3).map(x => x.t) };
  }

  // ---- play one of the user's playlists, or one song of it, and check it really started ----
  // → { status: 'ok', playlist, track, started, shuffled, playing } | ambiguous | notFound |
  //   { status: 'noTrack', playlist, near } | { status: 'ambiguousTrack', playlist, candidates } | { status: 'empty', playlist } | { status: 'wrong', playlist }
  async function play(name, { track, shuffle = false, id } = {}) {
    const r = id ? { status: 'ok', playlist: library.list.find(p => p.id === id) } : await resolve(name);
    if (r.status !== 'ok' || !r.playlist) return r.status === 'ok' ? { status: 'notFound', near: [] } : r;
    const data = await getPlaylist(r.playlist);
    const playable = data.tracks.map((t, i) => ({ t, i })).filter(x => x.t.videoId && x.t.available !== false);
    if (!playable.length) return { status: 'empty', playlist: data };

    let start = playable[0];
    if (track) {
      const f = findTrack(data.tracks, track);
      if (f.status === 'ambiguous') return { status: 'ambiguousTrack', playlist: data, candidates: f.candidates };
      if (f.status !== 'ok') return { status: 'noTrack', playlist: data, near: f.near };
      start = { t: f.track, i: f.index };
    }
    const res = await call('play', { play: { watchEndpoint: { videoId: start.t.videoId, playlistId: data.id, index: start.i } }, videoId: start.t.videoId }, 25000);
    if (res?.noTab) throw fail('NO_TAB', 'The YouTube Music extension did not open a tab, so it is probably out of date: reload it in chrome://extensions');
    const playing = res?.playing;
    if (!playing || playing.videoId !== start.t.videoId) return { status: 'wrong', playlist: data, playing: playing || null };
    let shuffled = false;
    if (shuffle && res.started && !track) {
      try { shuffled = !!(await call('shuffle', {}, 15000))?.shuffled; } catch { /* playing is what matters */ }
    }
    return { status: 'ok', playlist: data, track: start.t, started: !!res.started, shuffled, playing };
  }

  // ---- journal: every change JARVIS makes, so it can be taken back ----
  // read on first use: in the app the store is the cortex, which opens after this service is built
  let journal = null, entrySeq = 0;
  function entries() {
    if (journal) return journal;
    try { journal = journalStore.load().slice(-JOURNAL_MAX); } catch (err) { log('ytplaylists: could not read the undo journal:', err.message); return []; }
    entrySeq = journal.reduce((n, e) => Math.max(n, e.id || 0), 0);
    return journal;
  }
  function record(entry) {
    entries();
    const e = { id: ++entrySeq, at: now(), undone: false, ...entry };
    journal = [...(journal || []), e].slice(-JOURNAL_MAX);
    try { journalStore.append(e); } catch (err) { log('ytplaylists: could not save the undo journal:', err.message); }
    return e;
  }
  function markUndone(e) {
    e.undone = true;
    try { journalStore.markUndone(e); } catch (err) { log('ytplaylists: could not save the undo journal:', err.message); }
  }

  // ---- adding songs ----
  // a playlist the user can change, by name → { status: 'ok', playlist } | ambiguous | notFound | { status: 'readonly', playlist }
  async function target(name) {
    const r = await resolve(name);
    if (r.status !== 'ok') return r;
    return r.playlist.editable ? r : { status: 'readonly', playlist: r.playlist };
  }

  const sameSong = (a, b) => norm(a.title) === norm(b.title) && norm((a.artists || []).join(' ')) === norm((b.artists || []).join(' '));
  const countBy = list => { const m = new Map(); for (const x of list) m.set(x.videoId, (m.get(x.videoId) || 0) + 1); return m; };

  // read the playlist until the change shows up (YouTube Music can lag a few seconds behind a write)
  async function confirmed(meta, check) {
    let data = null;
    for (let i = 0; i < 4; i++) {
      await sleep(i ? 1000 : 800);
      data = await getPlaylist(meta, { refresh: true });
      if (check(data.tracks)) return { ok: true, data };
    }
    return { ok: false, data };
  }

  // songs: [{ videoId, title, artists }] → { status: 'ok', playlist, added, skipped, held, verified, entry } |
  //   duplicate | tooMany | full | failed | notFound | ambiguous | readonly
  async function addSongs(name, songs, { allowDuplicate = false } = {}) {
    const t = await target(name);
    if (t.status !== 'ok') return t;
    const meta = t.playlist;
    const data = await getPlaylist(meta, { maxAgeMs: FRESH_MS });
    const before = countBy(data.tracks);

    const add = [], skipped = [], held = [];
    for (const s of songs) {
      if (!allowDuplicate && (before.has(s.videoId) || add.some(a => a.videoId === s.videoId))) skipped.push(s);
      else if (!allowDuplicate && data.tracks.some(x => sameSong(x, s))) held.push({ song: s, existing: data.tracks.find(x => sameSong(x, s)) });   // same song, another version
      else add.push(s);
    }
    if (!add.length) return { status: 'duplicate', playlist: meta, skipped, held };
    if (add.length > cfg().maxBulk) return { status: 'tooMany', playlist: meta, max: cfg().maxBulk };
    if (data.tracks.length + add.length > MAX_TRACKS) return { status: 'full', playlist: meta };

    const res = await call('playlist_edit', { id: meta.id, actions: add.map(s => ({ action: 'ADD_VIDEO', videoId: s.videoId })), allowDuplicate }, 30000);
    tracks.delete(meta.id);
    if (!res?.ok) {
      // the duplicate check refuses with a failure: see what really happened before reporting anything
      const d = await getPlaylist(meta, { refresh: true });
      const now1 = countBy(d.tracks);
      if (add.every(s => (now1.get(s.videoId) || 0) > (before.get(s.videoId) || 0))) return { status: 'ok', playlist: meta, added: add, skipped, held, verified: true, entry: null };
      if (add.every(s => before.has(s.videoId))) return { status: 'duplicate', playlist: meta, skipped: add, held };
      return { status: 'failed', playlist: meta, apiStatus: res?.status || null };
    }
    const handles = new Map((res.results || []).map(r => [r.videoId, r.setVideoId]));
    const entry = record({ op: 'add', playlistId: meta.id, playlistTitle: meta.title, items: add.map(s => ({ videoId: s.videoId, setVideoId: handles.get(s.videoId) || null, title: s.title, artists: s.artists || [] })) });
    const seen = await confirmed(meta, list => { const n = countBy(list); return add.every(s => (n.get(s.videoId) || 0) > (before.get(s.videoId) || 0)); });
    return { status: 'ok', playlist: meta, added: add, skipped, held, verified: seen.ok, entry };
  }

  // the song playing right now in YouTube Music
  async function addCurrent(name, opts = {}) {
    const t = await target(name);
    if (t.status !== 'ok') return t;
    const s = (await ytm?.status())?.playing;
    if (!s?.videoId) return { status: 'nothing' };
    const r = await addSongs(name, [{ videoId: s.videoId, title: s.title, artists: s.artist ? [s.artist] : [] }], opts);
    return { ...r, current: true };
  }

  // songs by name ("stronger by kanye west"): every song is found before anything is changed
  async function addByName(name, queries, opts = {}) {
    const t = await target(name);
    if (t.status !== 'ok') return t;
    if (!ytm?.findSong) throw fail('NO_LINK', 'Song search is not available');
    const songs = [];
    for (const q of queries) {
      const f = await ytm.findSong(q);
      if (f.error) return { status: 'songNotFound', query: q, message: f.error };
      if (!f.sure) return { status: 'ambiguousSong', query: q, candidates: [f.item, ...f.alts] };
      songs.push({ videoId: f.item.videoId, title: f.item.title, artists: f.item.artists || [] });
    }
    return addSongs(name, songs, opts);
  }

  // take back the last change JARVIS made (only songs it added, and only if they are still there)
  async function undo() {
    const e = [...entries()].reverse().find(x => !x.undone);
    if (!e) return { status: 'nothing' };
    const meta = library.list.find(p => p.id === e.playlistId) || { id: e.playlistId, title: e.playlistTitle, editable: true };
    const data = await getPlaylist(meta, { refresh: true });
    const live = e.items.map(it => data.tracks.find(x => x.setVideoId && x.setVideoId === it.setVideoId)).filter(Boolean);
    if (!live.length) { markUndone(e); return { status: 'gone', entry: e }; }
    const res = await call('playlist_edit', { id: e.playlistId, actions: live.map(x => ({ action: 'REMOVE_VIDEO', videoId: x.videoId, setVideoId: x.setVideoId })) }, 30000);
    tracks.delete(e.playlistId);
    if (!res?.ok) return { status: 'failed', entry: e };
    const gone = await confirmed(meta, list => live.every(x => !list.some(y => y.setVideoId === x.setVideoId)));
    markUndone(e);
    return { status: 'ok', entry: e, removed: live, verified: gone.ok };
  }

  // an answer to "which playlist?" → the chosen one, or null
  // ("the second one", "gym cardio", "yes" when one was offered)
  function pick(text, candidates) {
    const t = norm(text).replace(/^(?:the|that|number)\s+/, '').replace(/\s+(?:one|please)$/, '');
    if (!t || !candidates?.length) return null;
    if (candidates.length === 1 && YES.test(t)) return candidates[0];
    for (const [re, i] of ORDINALS) if (re.test(t) && candidates[i]) return candidates[i];
    if (/^(?:the )?last\b/.test(t)) return candidates[candidates.length - 1];
    const q = cleanName(text);
    const scored = candidates.map(p => ({ p, s: Math.max(matchText(q, p.title ?? ''), matchText(q, `${p.title ?? ''} ${(p.artists || []).join(' ')}`)) })).sort((a, b) => b.s - a.s);
    const [top, next] = scored;
    return top && top.s >= OK_SCORE && (!next || top.s - next.s >= GAP) ? top.p : null;
  }

  function invalidate(id) { if (id) tracks.delete(id); else tracks.clear(); library.at = 0; }

  // a compact line for the prompt, from what is already cached (never fetches)
  function digest() {
    const n = cfg().digestSize;
    const list = library.list.filter(p => p.kind !== 'auto');
    if (!list.length || n <= 0) return '';
    const shown = list.slice(0, n).map(p => `${p.title}${p.trackCount !== null && p.trackCount !== undefined ? ` (${p.trackCount})` : ''}${p.kind === 'saved' ? ' [saved]' : ''}`);
    return `The user's YouTube Music playlists${library.at ? '' : ' (last known)'}: ${shown.join(', ')}${list.length > n ? `, and ${list.length - n} more` : ''}.`;
  }

  // playlist titles from the cached library (never fetches): vocabulary for speech recognition
  function titles() { return library.list.filter(p => p.kind !== 'auto').map(p => p.title).filter(Boolean); }

  function titleOf(id) { return library.list.find(p => p.id === id)?.title || null; }

  // the extension (re)connected: the old picture may be wrong, refresh it in the background
  function onLink(connected) {
    if (!connected) return;
    library.at = 0;
    // only when a YouTube Music tab is already open: connecting must never open a tab by itself
    call('status', {}, 10000).then(s => (s?.noTab ? null : getLibrary()), () => null).catch(err => log('ytplaylists: library refresh:', err.message));
  }

  return { library: getLibrary, resolve, playlist: getPlaylist, open, play, pick, findTrack, addSongs, addCurrent, addByName, undo, invalidate, digest, titles, titleOf, onLink, get connected() { return link.connected; } };
}

module.exports = { createYtPlaylists, cleanName, DEFAULT_MUSIC };
