// Model tools for the user's YouTube Music playlists (live data through the extension, see core/media/ytplaylists.js).
//   ytm_library       — list the user's playlists, or show the songs in one.
//   ytm_play_library  — play one of the user's playlists, or one song from it.
// Playlist names are resolved in code against the real library: the tool answers with data or with the
// exact question to ask (ambiguous / not found), never a guess.
const { clock } = require('../media/say');
const { norm } = require('../media/rank');

const DEFAULT_PLAYLISTS = 40;
const DEFAULT_TRACKS = 25;

const count = p => (p.trackCount === null || p.trackCount === undefined ? '' : ` (${p.trackCount} ${p.trackCount === 1 ? 'track' : 'tracks'})`);
const label = p => `${p.title}${count(p)}${p.kind === 'saved' ? ', saved from someone else' : ''}`;
// the question to hand back to the model when a name does not settle to one playlist
const which = (name, cands) => (cands.length === 1
  ? `No playlist is called exactly "${name}". The closest is ${label(cands[0])}: ask the user if they mean it`
  : `More than one playlist matches "${name}": ask the user which: ${cands.map(label).join('; ')}`);
const page = (n, fallback) => (Number.isInteger(n) && n > 0 ? n : fallback);

function createYtLibraryTool({ playlists }) {
  return {
    name: 'ytm_library',
    hint: 'ytm_library: the user\'s OWN playlists: list them or see the songs in one. For \'my gym playlist\' style names use this, not youtube_music. Pass the playlist name as the user said it. ALWAYS call it for a playlist question, even if an earlier reply in this chat said it failed or was not connected: that may be fixed now, so never repeat an old failure without calling the tool.',
    description: "The user's own YouTube Music playlists, read live: view=playlists lists them; view=playlist shows the songs in one (name as the user said it). query filters, limit/offset page.",
    timeoutMs: 90000,
    params: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['playlists', 'playlist'], description: 'playlists = list all, playlist = songs in one (default: playlist when a name is given)' },
        playlist: { type: 'string', description: 'playlist name or id, for view=playlist' },
        query: { type: 'string', description: 'only songs or playlists whose title or artist contains this' },
        limit: { type: 'integer', description: 'rows to show (default 25 songs, 40 playlists)' },
        offset: { type: 'integer', description: 'rows to skip, to page through' },
        refresh: { type: 'boolean', description: 'force a fresh read instead of the short cache' },
      },
      additionalProperties: false,
    },
    async run(a = {}) {
      if (!playlists.connected) throw new Error('The YouTube Music extension is not connected');
      const view = a.view || (a.playlist ? 'playlist' : 'playlists');
      const refresh = a.refresh === true;
      const q = a.query ? norm(a.query) : '';
      const offset = Number.isInteger(a.offset) && a.offset > 0 ? a.offset : 0;

      if (view === 'playlists') {
        const lib = await playlists.library({ refresh });
        let list = lib.playlists.filter(p => p.kind !== 'auto' || p.id === 'LM');
        if (q) list = list.filter(p => norm(p.title).includes(q));
        if (!list.length) return q ? `No playlist matches "${a.query}".` : 'The library has no playlists.';
        const limit = page(a.limit, DEFAULT_PLAYLISTS);
        const shown = list.slice(offset, offset + limit);
        const more = offset + shown.length < list.length ? ` Showing ${offset + 1}-${offset + shown.length} of ${list.length}; ask for more with offset ${offset + shown.length}.` : '';
        return `${list.length} playlists${lib.stale ? ' (last known list: could not refresh)' : ''}: ${shown.map(label).join('; ')}.${more}`;
      }

      if (!a.playlist) throw new Error('playlist is required: which playlist?');
      const r = await playlists.open(a.playlist, { refresh });
      if (r.status === 'ambiguous') throw new Error(which(a.playlist, r.candidates));
      if (r.status === 'notFound') throw new Error(`No playlist called "${a.playlist}".${r.near.length ? ` Closest: ${r.near.map(label).join('; ')}.` : ' Use view=playlists to see what exists.'}`);

      const rows = r.tracks.map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => !q || norm(`${t.title} ${(t.artists || []).join(' ')}`).includes(q));
      const head = `${r.title}${count({ trackCount: r.tracks.length })}${r.editable ? '' : ', read-only'}${r.truncated ? ' (long playlist: first part only)' : ''} [playlist ${r.id}]`;
      if (!rows.length) return `${head}. ${q ? `No song matches "${a.query}".` : 'It is empty.'}`;
      const limit = page(a.limit, DEFAULT_TRACKS);
      const shown = rows.slice(offset, offset + limit);
      const line = ({ t, n }) => `${n}. ${t.title}${t.artists?.length ? ' - ' + t.artists.join(', ') : ''}${t.durationSec ? ` (${clock(t.durationSec)})` : ''}${t.available === false ? ' [unavailable]' : ''}`;
      const more = offset + shown.length < rows.length ? ` Showing ${offset + 1}-${offset + shown.length} of ${rows.length}; ask for more with offset ${offset + shown.length}.` : '';
      return `${head}\n${shown.map(line).join('\n')}${more}`;
    },
  };
}

const song = t => `"${t.title}"${t.artists?.length ? ' by ' + t.artists.join(', ') : ''}`;

function createYtPlayLibraryTool({ playlists }) {
  return {
    name: 'ytm_play_library',
    hint: 'ytm_play_library: play one of the user\'s OWN playlists, or one song from it (track), optionally shuffled. \'play my gym playlist\', \'play stronger from my gym playlist\'. If it says more than one playlist matches, ask the user which.',
    description: "Play one of the user's OWN YouTube Music playlists, or one song of it (track), optionally shuffled, and confirm it started.",
    timeoutMs: 90000,
    params: {
      type: 'object',
      properties: {
        playlist: { type: 'string', description: 'playlist name or id' },
        track: { type: 'string', description: 'a song inside that playlist to start from, e.g. "lose yourself" or "stronger by kanye west"' },
        shuffle: { type: 'boolean', description: 'shuffle the playlist (not with track)' },
      },
      required: ['playlist'],
      additionalProperties: false,
    },
    async run(a = {}) {
      if (!playlists.connected) throw new Error('The YouTube Music extension is not connected');
      if (!a.playlist) throw new Error('playlist is required: which playlist?');
      const r = await playlists.play(a.playlist, { track: a.track, shuffle: a.shuffle === true });
      if (r.status === 'ambiguous') throw new Error(which(a.playlist, r.candidates));
      if (r.status === 'notFound') throw new Error(`No playlist called "${a.playlist}".${r.near.length ? ` Closest: ${r.near.map(label).join('; ')}.` : ' Use ytm_library to see what exists.'}`);
      const pl = r.playlist;
      if (r.status === 'empty') throw new Error(`${pl.title} has no playable songs.`);
      if (r.status === 'ambiguousTrack') throw new Error(`More than one song in ${pl.title} matches "${a.track}": ask the user which: ${r.candidates.map(song).join('; ')}`);
      if (r.status === 'noTrack') throw new Error(`No song matching "${a.track}" in ${pl.title}.${r.near.length ? ` Closest: ${r.near.map(song).join('; ')}.` : ''}`);
      if (r.status === 'wrong') throw new Error('YouTube Music played something else');
      const what = a.track ? `${song(r.track)} from ${pl.title}` : `${pl.title} (${pl.tracks.length} tracks), starting with ${song(r.track)}`;
      if (!r.started) return `Loaded ${what}, but Chrome blocked autoplay. The user must press play once in the YouTube Music tab.`;
      return `Playing ${what} (verified).${a.shuffle && !a.track ? (r.shuffled ? ' Shuffled.' : ' Could not shuffle it.') : ''}`;
    },
  };
}

const names = list => list.map(s => `"${s.title}"${s.artists?.length ? ' by ' + s.artists.join(', ') : ''}`).join('; ');
const detail = t => `${song(t)}${t.album ? ` (${t.album}${t.duration ? ', ' + t.duration : ''})` : t.duration ? ` (${t.duration})` : ''}`;

// what happened → text for the model; failures that need the user are thrown as the question to ask
function reportAdd(r, a) {
  switch (r.status) {
    case 'ambiguous': throw new Error(which(a.playlist, r.candidates));
    case 'notFound': throw new Error(`No playlist called "${a.playlist}".${r.near?.length ? ` Closest: ${r.near.map(label).join('; ')}.` : ''} Creating playlists is not available yet: tell the user.`);
    case 'readonly': throw new Error(`${r.playlist.title} is not the user's own editable playlist (saved from someone else, or automatic), so it cannot be changed. Offer one of their own playlists.`);
    case 'nothing': throw new Error('Nothing is playing in YouTube Music right now.');
    case 'songNotFound': throw new Error(r.message);
    case 'ambiguousSong': throw new Error(`More than one song matches "${r.query}": ask the user which: ${r.candidates.map(detail).join('; ')}`);
    case 'tooMany': throw new Error(`That is more than ${r.max} songs at once. Ask the user to split it.`);
    case 'full': throw new Error(`${r.playlist.title} is full (YouTube Music allows 5000 songs).`);
    case 'failed': throw new Error(`YouTube Music refused the change${r.apiStatus ? ` (${r.apiStatus})` : ''}. Nothing was added.`);
    case 'duplicate': return `Nothing added: ${names(r.skipped.concat(r.held.map(h => h.song)))} already in ${r.playlist.title}${r.held.length ? ' (same song, other version)' : ''}. Tell the user; only add a copy if they ask (allowDuplicate).`;
    case 'ok': {
      const extra = `${r.skipped.length ? ` Skipped, already there: ${names(r.skipped)}.` : ''}${r.held.length ? ` Not added, same song already in the playlist: ${names(r.held.map(h => h.song))}. Ask if they want a copy.` : ''}`;
      return r.verified
        ? `Added ${names(r.added)} to ${r.playlist.title} (verified).${extra} The user can say "undo" to take it back.`
        : `Sent ${names(r.added)} to ${r.playlist.title}, but YouTube Music has not shown the change yet. Do not say it is done; offer to check in a moment.${extra}`;
    }
    default: throw new Error('Unexpected answer from YouTube Music');
  }
}

function createYtEditTool({ playlists }) {
  return {
    name: 'ytm_playlist_edit',
    hint: 'ytm_playlist_edit: add songs to the user\'s OWN playlists: songs by name (add), the song playing now (add_current), or undo. Use the playlist the user names; if none, ask which. Say it is done only when the result says Added.',
    description: "Change the user's OWN YouTube Music playlists. op=add: add songs by name to a playlist (songs: [\"title by artist\"]). op=add_current: add the song playing now. op=undo: take back the last add. The playlist is the one the user named; if they did not name one, ask. Duplicates are skipped.",
    timeoutMs: 90000,
    params: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'add_current', 'undo'] },
        playlist: { type: 'string', description: 'playlist name or id (not for undo)' },
        songs: { type: 'array', items: { type: 'string' }, description: 'for add: songs as the user said them, e.g. "stronger by kanye west"' },
        allowDuplicate: { type: 'boolean', description: 'only when the user asks for a second copy' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    async run(a = {}) {
      if (!playlists.connected) throw new Error('The YouTube Music extension is not connected');
      if (a.op === 'undo') {
        const r = await playlists.undo();
        if (r.status === 'nothing') return 'There is nothing to undo.';
        if (r.status === 'gone') return `Those songs are no longer in ${r.entry.playlistTitle}, so there is nothing to take back.`;
        if (r.status === 'failed') throw new Error('YouTube Music refused the undo. Nothing was removed.');
        return `Undone: removed ${names(r.removed)} from ${r.entry.playlistTitle}${r.verified ? ' (verified)' : ', but YouTube Music has not shown it yet'}.`;
      }
      if (!['add', 'add_current'].includes(a.op)) throw new Error('op must be add, add_current or undo');
      if (!a.playlist) throw new Error('playlist is required: ask the user which playlist');
      const opts = { allowDuplicate: a.allowDuplicate === true };
      if (a.op === 'add_current') return reportAdd(await playlists.addCurrent(a.playlist, opts), a);
      const songs = (Array.isArray(a.songs) ? a.songs : []).map(s => String(s || '').trim()).filter(Boolean);
      if (!songs.length) throw new Error('songs is required: which songs?');
      return reportAdd(await playlists.addByName(a.playlist, songs, opts), a);
    },
  };
}

module.exports = { createYtLibraryTool, createYtPlayLibraryTool, createYtEditTool };
