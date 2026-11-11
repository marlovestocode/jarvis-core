// Media tools for the model.
//   media_status  — what is playing right now, read fresh from Windows (title, artist, album, app, state,
//                   position, duration, shuffle/repeat, system and app volume).
//   media_control — one verified control on the right player (see core/media/service.js).
// Without a media service (host off) media_control falls back to a media key through sysmon
// (POST /media/<key>, needs an Origin header), which works but cannot be verified.
const { SYSMON } = require('./sysmon');
const { ack, failure, clarifyQuestion, nowPlaying, clock } = require('../media/say');

const ACTIONS = ['playpause', 'next', 'prev', 'stop', 'mute', 'volup', 'voldown'];   // sysmon media keys
const DONE = { playpause: 'Toggled play/pause', next: 'Skipped to next track', prev: 'Went to previous track', stop: 'Stopped playback', mute: 'Toggled mute', volup: 'Volume up', voldown: 'Volume down' };
const CONTROLS = ['play', 'pause', 'toggle', 'stop', 'next', 'prev', 'seek', 'volume', 'mute', 'unmute', 'shuffle', 'repeat', 'queue'];

async function pressKey(fetch, action, timeoutMs = 3000) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown media action "${action}". Use one of: ${ACTIONS.join(', ')}`);
  let r;
  try {
    r = await fetch(`${SYSMON}/media/${action}`, { method: 'POST', headers: { Origin: 'http://127.0.0.1' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Sysmon is not running');
  }
  if (r.status === 204 || r.ok) return DONE[action];
  if (r.status === 429) throw new Error('Too fast, try again in a moment');
  if (r.status === 503) throw new Error('Media keys unavailable');
  throw new Error(`Sysmon refused the media key (HTTP ${r.status})`);
}

function createMediaTool({ fetch = globalThis.fetch, timeoutMs = 3000, service } = {}) {
  if (!service) {
    return {
      name: 'media_control',
      description: 'Control media playback on this PC with media keys: play/pause, next, previous, stop, mute, volume up/down.',
      params: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS } }, required: ['action'], additionalProperties: false },
      run: (args = {}) => pressKey(fetch, args.action, timeoutMs),
    };
  }
  return {
    name: 'media_control',
    description: 'Control what is playing on this PC and confirm it worked. Actions: play, pause, toggle, stop, next, prev, seek (to or by seconds), volume (set 0-100 or by -100..100 percent points; system volume unless app is given), mute, unmute, shuffle (on), repeat (mode none|track|list), queue (not supported by Windows; returns why). app targets one player, e.g. "Spotify" or "Chrome".',
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...CONTROLS, ...ACTIONS.filter(a => !CONTROLS.includes(a))] },
        app: { type: 'string', description: 'player to control; omit for the one playing' },
        to: { type: 'number', description: 'seek: absolute position in seconds' },
        by: { type: 'number', description: 'seek: relative seconds (negative = back); volume: percent points' },
        set: { type: 'number', description: 'volume: 0-100 percent' },
        on: { type: 'boolean', description: 'shuffle on/off' },
        mode: { type: 'string', enum: ['none', 'track', 'list'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(a = {}) {
      const cmd = { action: a.action };
      if (a.action === 'playpause') cmd.action = 'toggle';
      if (a.action === 'volup' || a.action === 'voldown') { cmd.action = 'volume'; cmd.by = a.action === 'volup' ? 0.1 : -0.1; }
      if (!CONTROLS.includes(cmd.action)) throw new Error(`Unknown media action "${a.action}"`);
      if (a.app) cmd.app = a.app;
      if (cmd.action === 'seek') { if (Number.isFinite(a.to)) cmd.to = a.to; else if (Number.isFinite(a.by)) cmd.by = a.by; else throw new Error('seek needs to or by'); }
      if (cmd.action === 'volume' && cmd.by === undefined) {
        if (Number.isFinite(a.set)) cmd.set = Math.max(0, Math.min(100, a.set)) / 100;
        else if (Number.isFinite(a.by)) cmd.by = a.by / 100;
        else throw new Error('volume needs set or by');
      }
      if (a.app && ['volume', 'mute', 'unmute'].includes(cmd.action)) cmd.target = 'app';
      if (cmd.action === 'shuffle') cmd.on = a.on !== false;
      if (cmd.action === 'repeat') cmd.mode = a.mode || 'track';
      const r = await service.act(cmd);
      if (r.clarify) throw new Error(`More than one player: ask the user ${clarifyQuestion(r.clarify)}`);
      if (!r.ok) throw new Error(failure(r));
      const now = r.session ? ` Now: ${r.session.status} ${r.session.title ? `"${r.session.title}"${r.session.artist ? ' by ' + r.session.artist : ''}` : ''} in ${r.session.app}${r.session.position !== null && r.session.duration ? ` at ${clock(r.session.position)} of ${clock(r.session.duration)}` : ''}.` : '';
      return `${ack(r)}${r.via === 'keys' ? '' : ' Verified.'}${now}`;
    },
  };
}

function createMediaStatusTool({ service }) {
  return {
    name: 'media_status',
    description: 'What is playing on this PC right now: title, artist, album or show, app, playing/paused, position and duration, shuffle/repeat, system and app volume. Windows does not expose the queue.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const st = await service.state();
      const lines = st.sessions.map(s => `${s.current ? '[current] ' : ''}${nowPlaying(s, false)}${s.shuffle !== null ? ` Shuffle ${s.shuffle ? 'on' : 'off'}.` : ''}${s.repeat ? ` Repeat ${s.repeat}.` : ''}${s.volume !== null ? ` ${s.app} volume ${Math.round(s.volume * 100)}%.` : ''}`);
      const sys = st.system.volume !== null ? `System volume ${Math.round(st.system.volume * 100)}%${st.system.muted ? ', muted' : ''}.` : 'System volume unreadable.';
      return (lines.length ? lines.join('\n') : 'Nothing is playing.') + '\n' + sys;
    },
  };
}

// youtube_music: search-and-play, the queue and likes in the user's YouTube Music tab (extension).
// secret: true keeps the picked titles out of every result and reply (the chat shows tool results), so a surprise stays one.
// The tool remembers the secret picks itself, so "skip to the first one" still works (play_secret) and reveal_secret tells them.
// taste (W2 §4, plan E13): play_random / queue_random with no artist, or a phrase like "songs you think I'd like",
// pick from the user's own play graph first; picks are played by searching "<title> by <artist>" (the verified path).
// With no graph they fall back to today's artist search. current() → { title, artist } of what plays now, or null.
const TASTE_FILLER = /\b(?:i'?d|i would|i'?ll|i will|i|probably|like|love|enjoy|for me|my taste|surprise me|you think|you|think|recommend\w*|some|songs?|tracks?|music|something|stuff|random|a|an|the|that|please|play|queue|by|me|my)\b|[?!.,']/gi;
const TASTE_PHRASE = /\b(?:i'?d|i would|i'?ll|i will|i)\s+(?:probably\s+)?(?:like|love|enjoy)\b|\bfor me\b|\bmy taste\b|\bsurprise me\b|\byou think\b|\brecommend/i;

function createYtMusicTool({ ytm, taste = null, current = async () => null }) {
  const { named } = require('../media/ytmusic');
  // → picks, or null when taste cannot answer (none wired, empty graph, an error)
  async function tastePicks(query, n) {
    if (!taste) return null;
    // "Queen for me" keeps Queen: the taste words and fillers are dropped, what is left (if anything) is the artist
    const rest = String(query || '').replace(TASTE_FILLER, ' ').replace(/\s+/g, ' ').trim();
    const artist = !query ? null : !TASTE_PHRASE.test(query) ? query : rest.length >= 2 ? rest.toLowerCase() : null;
    let now = null;
    try { now = await current(); } catch { /* no media state */ }
    try { const picks = taste.suggest({ n, artist, current: now }); return picks.length ? picks : null; } catch { return null; }
  }
  const asked = q => `${q.title}${q.artist ? ' by ' + q.artist : ''}`;
  const secrets = [];   // { title, artist } in the order they were picked
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const isSecret = x => secrets.some(p => norm(p.title) === norm(x?.title));
  const keep = it => { if (it && !isSecret(it)) secrets.push({ title: it.title, artist: it.artists?.length ? it.artists.join(', ') : it.artist || '' }); };
  return {
    name: 'youtube_music',
    description: 'YouTube Music in Chrome: play a song, album, playlist or artist by name right now (action play; also for "skip to <song>"); play_next and add_to_queue only QUEUE it and do not start it; read what is up next; clear the queue; like or dislike the current song. query is what to search, e.g. "bohemian rhapsody by queen", "album american idiot", "some lofi". play_random plays one random song by the artist in query ("play a random song by X"); queue_random queues `count` random songs by the artist in query ("queue 5 random songs by X"). With no query (or "songs I would like") both pick from their own listening history. secret=true when the user wants to be surprised: the titles are then hidden from the result and remembered; play_secret (index 1, 2, ...) plays one of them, reveal_secret tells the user which they were.',
    timeoutMs: 40000,
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'play_next', 'add_to_queue', 'up_next', 'clear_queue', 'like', 'dislike', 'play_secret', 'reveal_secret', 'queue_random', 'play_random'] },
        query: { type: 'string', description: 'for play / play_next / add_to_queue' },
        secret: { type: 'boolean', description: 'true to hide the title from the result and remember it as a secret pick' },
        index: { type: 'number', description: 'for play_secret: which secret pick, 1 is the first' },
        count: { type: 'number', description: 'for queue_random: how many songs (default 5, at most 10)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run({ action, query, secret, index, count } = {}) {
      if (!ytm.connected) throw new Error('The YouTube Music extension is not connected');
      const random = action === 'play_random' || action === 'queue_random';
      if (['play', 'play_next', 'add_to_queue'].includes(action) && !query) throw new Error('query is required');
      if (random) {
        const want = action === 'play_random' ? 1 : Math.max(1, Math.min(10, Math.round(Number(count)) || 5));
        const picks = await tastePicks(query, action === 'play_random' ? 3 : want);
        if (picks && action === 'play_random') {
          for (const pick of picks) {
            const r = await ytm.play(asked(pick));
            if (!r.ok) continue;
            if (secret) { keep(r.item); return 'Playing a secret pick from your own history (verified). The title stays hidden.'; }
            return r.started ? `Playing ${named(r.item)} (verified), picked from their history: ${pick.why}.` : `Loaded ${named(r.item)}, but ${r.message}`;
          }
        }
        if (picks && action === 'queue_random') {
          const added = [];
          let failed = 0;
          for (const pick of picks) { const r = await ytm.enqueue(asked(pick), 'end'); if (r.ok) added.push({ item: r.item, why: pick.why }); else failed++; }
          if (added.length) {
            if (secret) { for (const a of added) keep(a.item); return `Added ${added.length} secret picks from your history to the end of the queue (verified). The titles stay hidden.`; }
            return `Added ${added.length} songs from their history to the end of the queue (verified): ${added.map(a => `${named(a.item)} (${a.why})`).join('; ')}${failed ? `. ${failed} could not be queued` : ''}.`;
          }
        }
        if (!query || (TASTE_PHRASE.test(query) && String(query).replace(TASTE_FILLER, ' ').trim().length < 2)) throw new Error(taste ? "I don't know your taste yet. Name an artist." : 'query is required');
      }
      if (action === 'play_random') {
        const r = await ytm.playRandom(query);
        if (!r.ok) throw new Error(r.message);
        if (secret) { keep(r.item); return 'Playing a secret pick (verified). The title stays hidden.'; }
        return r.started ? `Playing ${named(r.item)} (verified).` : `Loaded ${named(r.item)}, but ${r.message}`;
      }
      if (action === 'queue_random') {
        const r = await ytm.queueRandom(query, count, 'end');
        if (!r.ok) throw new Error(r.message);
        if (secret) { for (const it of r.added) keep(it); return `Added ${r.added.length} secret picks to the end of the queue (verified)${r.failed ? `, ${r.failed} could not be queued` : ''}. The titles stay hidden.`; }
        return `Added ${r.added.length} random songs to the end of the queue (verified): ${r.added.map(it => named(it)).join('; ')}${r.failed ? `. ${r.failed} could not be queued` : ''}.`;
      }
      if (action === 'play_secret') {
        const n = Math.round(Number(index) || 1);
        const pick = secrets[n - 1];
        if (!pick) throw new Error(secrets.length ? `There are only ${secrets.length} secret picks` : 'There are no secret picks');
        const r = await ytm.play(`${pick.title}${pick.artist ? ' by ' + pick.artist : ''}`);
        if (!r.ok) throw new Error('Could not start that secret pick');
        return `Playing secret pick ${n} (verified). The title stays hidden.`;
      }
      if (action === 'reveal_secret') {
        if (!secrets.length) return 'There are no secret picks.';
        const list = secrets.map((p, i) => `${i + 1}. ${p.title}${p.artist ? ' by ' + p.artist : ''}`).join('; ');
        secrets.length = 0;
        return `Secret picks, now revealed: ${list}.`;
      }
      if (action === 'play') {
        const r = await ytm.play(query);
        if (!r.ok) throw new Error(r.message);
        if (secret) { keep(r.item); return r.started ? 'Playing a secret pick (verified). The title stays hidden.' : 'Loaded a secret pick, but Chrome blocked autoplay. Press play once in the YouTube Music tab.'; }
        return r.started ? `Playing ${named(r.item)} (verified).` : `Loaded ${named(r.item)}, but ${r.message}`;
      }
      if (action === 'play_next' || action === 'add_to_queue') {
        const r = await ytm.enqueue(query, action === 'play_next' ? 'next' : 'end');
        if (!r.ok) throw new Error(r.message);
        if (secret) { keep(r.item); return r.started ? `Queue was empty, so secret pick ${secrets.length} is playing.` : `Secret pick ${secrets.length} ${action === 'play_next' ? 'queued to play next' : 'added to the end of the queue'} (verified), NOT playing yet. The title stays hidden.`; }
        return r.started ? `Queue was empty, so ${named(r.item)} is playing.` : `${action === 'play_next' ? 'Queued to play next' : 'Added to the end of the queue'}, NOT playing yet: ${named(r.item)} (verified). To hear it now, call youtube_music action play with the same query`;
      }
      if (action === 'up_next') {
        const q = await ytm.upNext(5);
        if (q.none) return 'No YouTube Music tab is open.';
        const shown = x => (isSecret(x) ? 'a secret pick' : `"${x.title}"${x.artist ? ' by ' + x.artist : ''}`);
        return q.next.length ? 'Up next: ' + q.next.map(shown).join('; ') + (q.repeat && q.repeat !== 'NONE' ? `. Repeat ${q.repeat}.` : '.') : 'Nothing is queued after this song.';
      }
      if (action === 'clear_queue') { const r = await ytm.clear(); secrets.length = 0; return `Removed ${r.removed} songs after the current one.`; }
      if (action === 'like' || action === 'dislike') { const r = await ytm.like(action === 'like' ? 'LIKE' : 'DISLIKE'); return `Song is now ${r.value.toLowerCase()}d.`; }
      throw new Error(`Unknown action ${action}`);
    },
  };
}

module.exports = { createMediaTool, createMediaStatusTool, createYtMusicTool, pressKey, ACTIONS };
