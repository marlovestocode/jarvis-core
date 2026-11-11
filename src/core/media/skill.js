// Media fast path: a recognised media command or question is handled here, before any model call.
// handle(text, { source }) → null (not media: the model takes it) |
//   { reply, record, tool, ok, trace } — reply is what is shown/spoken (empty = silent),
//   record is what goes into the chat history.
// Windows media controls (service) drive whatever is playing; YouTube Music through the
// extension (ytm, optional) adds search-and-play, the queue, repeat, shuffle and likes.
const { parse, parseApp } = require('./intent');
const { answer, ack, failure, clarifyQuestion } = require('./say');
const { named } = require('./ytmusic');

const CLARIFY_MS = 30000;
const BROWSERS = new Set(['YouTube', 'Chrome', 'Edge', 'Brave', 'Opera', 'Firefox']);
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const sentence = s => cap(String(s).replace(/\.$/, '')) + '.';
const NO_LINK = "The YouTube Music extension isn't connected, so I can't search for songs.";

function createMediaSkill({ service, ytm = null, ytPlaylists = null, now = Date.now }) {
  let pending = null;   // a question JARVIS asked: { intent, options, at }
  let pendingList = null;   // "which playlist?": { intent, candidates, at }
  let pendingAdd = null;    // "add to which playlist?" ({ intent, stage: 'playlist' }) or "which song?" ({ intent, stage: 'song', candidates })

  function ask(intent, options, tool) {
    pending = { intent, options, at: now() };
    const q = clarifyQuestion(options);
    return { reply: q, record: q, tool, ok: true, clarify: options };
  }
  const say = (reply, ok = true, tool = 'youtube_music', record = reply) => ({ reply, record, tool, ok });

  async function handle(text, { source = 'text' } = {}) {
    const voice = source === 'voice';
    let intent = parse(text, { loose: voice });
    // answer to "which playlist?": a name, "the second one" or "yes"; anything else drops the question
    if (pendingList) {
      const q = pendingList; pendingList = null;
      const chosen = now() - q.at < CLARIFY_MS && ytPlaylists?.pick(text, q.candidates);
      if (chosen && (!intent || intent.kind === 'control' || intent.kind === 'find')) {
        try { return q.intent.kind === 'library-add' ? await libraryAdd({ ...q.intent, name: chosen.id }, voice) : await playLibrary({ ...q.intent, id: chosen.id }, voice); } catch (err) { return say(sentence(err.message || 'YouTube Music did not answer'), false); }
      }
    }
    // answer to "add it to which playlist?" (the next thing said is the playlist) or "which song?"
    if (pendingAdd) {
      const q = pendingAdd; pendingAdd = null;
      if (now() - q.at < CLARIFY_MS && (!intent || intent.kind === 'find' || intent.kind === 'control')) {
        try {
          if (q.stage === 'playlist') {
            const name = String(text).trim();
            // a short reply is a playlist name (even one that does not exist); a longer one is a different request
            if (name.split(/\s+/).length <= 3 || (await ytPlaylists.resolve(name)).status !== 'notFound') return await libraryAdd({ ...q.intent, name, explicit: true }, voice);
          }
          const chosen = ytPlaylists?.pick(text, q.candidates);
          if (chosen) return await libraryAdd({ ...q.intent, chosen: { videoId: chosen.videoId, title: chosen.title, artists: chosen.artists || [] } }, voice);
        } catch (err) { return say(sentence(err.message || 'YouTube Music did not answer'), false); }
      }
    }
    if (!intent && pending && now() - pending.at < CLARIFY_MS) {
      const app = parseApp(text);
      if (app && pending.options.some(o => o.toLowerCase() === app.toLowerCase())) intent = { ...pending.intent, app };
    }
    pending = null;
    if (!intent) return null;

    if (intent.kind === 'unsupported') return { reply: intent.message, record: intent.message, tool: 'media_control', ok: false };
    try {
      if (intent.kind === 'library-add') return await libraryAdd(intent, voice);
      if (intent.kind === 'library-undo') return await libraryUndo(voice);
      if (intent.kind === 'library') {
        const r = await playLibrary(intent, voice);
        if (r) return r;
        intent = { kind: 'find', mode: 'play', query: intent.query };   // nothing in the library by that name: the public catalog
      }
      if (intent.kind === 'find') return await find(intent, voice);
      if (intent.kind === 'query' && intent.what === 'next' && ytm?.connected) { const r = await upNext(voice); if (r) return r; }
      if (intent.kind === 'control' && (intent.action === 'like' || (intent.action === 'queue' && intent.op))) return await ytmControl(intent, voice);
      if (intent.kind === 'control' && ['shuffle', 'repeat'].includes(intent.action) && (!intent.app || BROWSERS.has(intent.app)) && await ytm?.isSource()) return await ytmControl(intent, voice);
    } catch (err) {
      const m = sentence(err.message || 'YouTube Music did not answer');
      return say(m, false);
    }

    if (intent.kind === 'query') {
      let st;
      try { st = await service.state(); } catch (err) {
        const m = `I can't read what's playing: ${err.message}.`;
        return { reply: m, record: m, tool: 'media_status', ok: false };
      }
      const pick = service.pickSession(st, { app: intent.app, action: 'query' });
      if (pick.clarify) return ask(intent, pick.clarify, 'media_status');
      if (pick.none && intent.app) { const m = sentence(pick.none); return { reply: m, record: m, tool: 'media_status', ok: true }; }
      const a = answer(intent, st, pick.session || null, voice);
      return { reply: a, record: answer(intent, st, pick.session || null, false), tool: 'media_status', ok: true };
    }

    // control
    if (intent.loose) {   // bare "stop": only a media command while something plays
      let st;
      try { st = await service.state(); } catch { return null; }
      if (!st.sessions.some(s => s.status === 'playing')) return null;
    }
    const r = await service.act(intent);
    if (r.clarify) return ask(intent, r.clarify, 'media_control');
    if (r.ok) {
      const a = ack(r);
      return { reply: voice ? '' : a, record: a, tool: 'media_control', ok: true, trace: r.trace };
    }
    if (r.none && intent.loose) return null;
    const f = r.none && !intent.app ? "Nothing's playing." : failure(r);
    return { reply: f, record: f, tool: 'media_control', ok: false, trace: r.trace };
  }

  const title = (t, voice) => (voice ? t.title : `“${t.title}”`);
  const songName = (t, voice) => `${title(t, voice)}${t.artists?.length ? ` by ${t.artists.join(', ')}` : ''}`;

  // "add this to gym", "add stronger by kanye west to my gym playlist", and the answer to "which playlist?"
  // → a reply, or null (not for this skill: a loose phrase that names no playlist of the user's)
  async function libraryAdd(intent, voice) {
    if (!ytm?.connected || !ytPlaylists) return intent.explicit || intent.current ? say(NO_LINK, false) : null;
    if (intent.current && !intent.name) {   // "add this song": the playlist is whatever is said next
      pendingAdd = { intent: { ...intent }, stage: 'playlist', at: now() };
      return { reply: 'Which playlist?', record: 'Which playlist?', tool: 'youtube_music', ok: true, clarify: [] };
    }
    const r = intent.chosen ? await ytPlaylists.addSongs(intent.name, [intent.chosen])
      : intent.current ? await ytPlaylists.addCurrent(intent.name) : await ytPlaylists.addByName(intent.name, intent.songs);
    switch (r.status) {
      case 'ok': {
        const what = songName(r.added[0], voice) + (r.added.length > 1 ? ` and ${r.added.length - 1} more` : '');
        const held = r.held?.length ? ` ${title(r.held[0].song, voice)} was already there in another version, so I left it out.` : '';
        if (!r.verified) return say(`I sent ${what} to ${r.playlist.title}, but YouTube Music hasn't shown it yet.${held}`, false);
        const kept = `Added ${songName(r.added[0], false)}${r.added.length > 1 ? ` and ${r.added.length - 1} more` : ''} to ${r.playlist.title}.${held}`;
        return say(voice ? `Added ${what} to ${r.playlist.title}.${held}` : `${kept} Say undo to take it back.`, true, 'youtube_music', kept);
      }
      case 'duplicate': return say(`${songName((r.skipped[0] || r.held[0].song), voice)} is already in ${r.playlist.title}.`);
      case 'ambiguous': {
        pendingList = { intent, candidates: r.candidates, at: now() };
        const n = r.candidates.map(p => p.title);
        const q = n.length === 1 ? `Do you mean ${n[0]}?` : `Which playlist: ${n.slice(0, -1).join(', ')} or ${n[n.length - 1]}?`;
        return { reply: q, record: q, tool: 'youtube_music', ok: true, clarify: n };
      }
      case 'notFound': return intent.explicit ? say(`I couldn't find a playlist called ${intent.name}.${r.near?.length ? ` Closest: ${r.near.map(p => p.title).join(', ')}.` : ''}`, false) : null;
      case 'readonly': return say(`${r.playlist.title} can't be changed: it's saved from someone else.`, false);
      case 'nothing': return say('Nothing is playing in YouTube Music.', false);
      case 'songNotFound': return say(r.message, false);
      case 'ambiguousSong': {
        pendingAdd = { intent: { ...intent }, stage: 'song', candidates: r.candidates, at: now() };
        const q = `Which one: ${r.candidates.map(t => songName(t, voice)).join(', or ')}?`;
        return { reply: q, record: q, tool: 'youtube_music', ok: true, clarify: r.candidates.map(t => t.title) };
      }
      case 'tooMany': return say(`That's more than ${r.max} songs at once. Try fewer.`, false);
      case 'full': return say(`${r.playlist.title} is full.`, false);
      default: return say("YouTube Music wouldn't take the change. Nothing was added.", false);
    }
  }

  async function libraryUndo(voice) {
    if (!ytm?.connected || !ytPlaylists) return null;
    const r = await ytPlaylists.undo();
    switch (r.status) {
      case 'ok': return say(`Undone: removed ${songName(r.removed[0], voice)}${r.removed.length > 1 ? ` and ${r.removed.length - 1} more` : ''} from ${r.entry.playlistTitle}.`);
      case 'gone': return say(`Those songs are no longer in ${r.entry.playlistTitle}.`);
      case 'nothing': return say("There's nothing to undo.");
      default: return say("YouTube Music wouldn't take the undo. Nothing was removed.", false);
    }
  }

  // "play my gym playlist", "play stronger from my gym playlist", "shuffle my chill playlist"
  // → a reply, or null when a loose phrase matches nothing in the library (the catalog search takes over)
  async function playLibrary(intent, voice) {
    if (!ytm?.connected || !ytPlaylists) return intent.explicit ? say(NO_LINK, false) : null;
    const opts = { track: intent.track, shuffle: !!intent.shuffle };
    const r = intent.id ? await ytPlaylists.play(null, { ...opts, id: intent.id }) : await ytPlaylists.play(intent.name, opts);
    const song = t => `${voice ? t.title : `“${t.title}”`}${t.artists?.length ? ` by ${t.artists.join(', ')}` : ''}`;
    switch (r.status) {
      case 'ok': {
        const what = intent.track ? `${song(r.track)} from ${r.playlist.title}` : `${r.playlist.title}`;
        const kept = `Playing ${intent.track ? what : `${r.playlist.title} (${r.playlist.tracks.length} songs)`}${r.shuffled ? ', shuffled' : ''}.`;
        if (!r.started) return say(`${cap(what)} is loaded, but Chrome blocked autoplay. Press play once in the YouTube Music tab.`, true, 'youtube_music', `Loaded ${what}. Chrome blocked autoplay.`);
        return say(voice ? '' : kept, true, 'youtube_music', kept);
      }
      case 'ambiguous': {
        pendingList = { intent, candidates: r.candidates, at: now() };
        const names = r.candidates.map(p => p.title);
        const q = names.length === 1 ? `Do you mean ${names[0]}?` : `Which playlist: ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}?`;
        return { reply: q, record: q, tool: 'youtube_music', ok: true, clarify: names };
      }
      case 'notFound': {
        if (!intent.explicit && intent.query) return null;
        const near = r.near.map(p => p.title);
        return say(`I couldn't find a playlist called ${intent.name}.${near.length ? ` Closest: ${near.join(', ')}.` : ''}`, false);
      }
      case 'noTrack': return say(`I couldn't find ${intent.track} in ${r.playlist.title}.${r.near.length ? ` Closest: ${r.near.map(t => song(t)).join('; ')}.` : ''}`, false);
      case 'ambiguousTrack': return say(`More than one song in ${r.playlist.title} matches ${intent.track}: ${r.candidates.map(t => song(t)).join('; ')}. Say which one.`, false);
      case 'empty': return say(`${r.playlist.title} has no playable songs.`, false);
      default: return say("YouTube Music played something else.", false);
    }
  }

  // "play X", "play X next", "add X to the queue"
  async function find(intent, voice) {
    if (intent.app && !BROWSERS.has(intent.app)) return say(`I can only search YouTube Music, not ${intent.app}.`, false);
    if (!ytm?.connected) return say(NO_LINK, false);
    if (intent.mode === 'play') {
      const r = await ytm.play(intent.query);
      if (!r.ok) return say(r.message, false);
      const what = named(r.item);
      if (!r.started) return say(r.message, true, 'youtube_music', `Loaded ${what}. ${r.message}`);
      // the user hears it start; name the pick aloud only when the match was not clear-cut
      return say(voice ? (r.sure ? '' : `Playing ${named(r.item, false)}.`) : `Playing ${what}.`, true, 'youtube_music', `Playing ${what}.`);
    }
    const r = await ytm.enqueue(intent.query, intent.mode);
    if (!r.ok) return say(r.message, false);
    if (r.started) return say(`Playing ${named(r.item, !voice)}.`);
    return say(`${intent.mode === 'next' ? 'Next up' : 'Added to the queue'}: ${named(r.item, !voice)}.`);
  }

  async function upNext(voice) {
    const q = await ytm.upNext(3);
    if (q.none) return null;   // no YouTube Music tab: the general answer applies
    if (q.repeat === 'ONE') return say('This song again. Repeat is on.', true, 'youtube_music');
    if (!q.next.length) return say("Nothing's queued after this.", true, 'youtube_music');
    const first = q.next[0];
    const one = `${voice ? first.title : `“${first.title}”`}${first.artist ? ` by ${first.artist}` : ''}`;
    const rest = q.next.slice(1).map(x => (voice ? x.title : `“${x.title}”`));
    const text = rest.length ? `Next: ${one}, then ${rest.join(', then ')}.` : `Next: ${one}.`;
    return say(text, true, 'youtube_music');
  }

  async function ytmControl(intent, voice) {
    if (!ytm?.connected) return say(NO_LINK, false);
    switch (intent.action) {
      case 'like': {
        const r = await ytm.like(intent.value);
        return say({ LIKE: 'Liked.', DISLIKE: 'Disliked.', INDIFFERENT: 'Like removed.' }[r.value] || 'Done.');
      }
      case 'queue': {
        if (intent.op === 'clear') { const r = await ytm.clear(); return say(r.removed ? 'Queue cleared.' : 'The queue was already empty.'); }
        const r = await ytm.removeNext();
        if (!r.ok) return say(r.message, false);
        return say(`Removed ${voice ? r.removed.title : `“${r.removed.title}”`}.`);
      }
      case 'repeat': { const r = await ytm.repeat(intent.mode); return say(r.value === 'off' ? 'Repeat off.' : `Repeat ${r.value}.`); }
      case 'shuffle': {
        if (intent.on === false) return say("YouTube Music shuffles the queue once; there's no shuffle mode to turn off.", false);
        const r = await ytm.shuffle();
        return r.ok ? say(voice ? '' : 'Shuffled.', true, 'youtube_music', 'Shuffled.') : say(r.message, false);
      }
      default: return say('Done.');
    }
  }

  return { handle };
}

module.exports = { createMediaSkill };
