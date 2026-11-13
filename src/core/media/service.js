// Media service: what is playing and control of it, read fresh from Windows every time.
// Every action follows the same loop: read the real state → pick the session the user means →
// run the one control that does it → re-read until the state shows it worked → retry once
// (only when retrying cannot double the effect) → report success, no-op, or failure.
// Source: the media host (Windows media controls + Core Audio). If the host is down, media keys
// through sysmon still work for play/pause, skip, stop, mute and volume steps, but cannot be verified.

const STATUS = { Playing: 'playing', Paused: 'paused', Stopped: 'stopped', Closed: 'closed', Opened: 'opened', Changing: 'changing' };
const REPEAT = { None: 'none', Track: 'track', List: 'list' };

// Friendly names and the audio-session process for common sources.
// An AUMID is "Chrome", "Spotify.exe", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "308046B0AF4A39CB" (Firefox)...
const KNOWN = [
  [/^308046B0AF4A39CB$|firefox/i, 'Firefox', 'firefox'],
  [/chrome/i, 'Chrome', 'chrome'],
  [/msedge|microsoftedge/i, 'Edge', 'msedge'],
  [/brave/i, 'Brave', 'brave'],
  [/opera/i, 'Opera', 'opera'],
  [/spotify/i, 'Spotify', 'spotify'],
  [/zunemusic|media\.player/i, 'Media Player', 'microsoft.media.player'],
  [/applemusic|apple music/i, 'Apple Music', 'applemusic'],
  [/tidal/i, 'TIDAL', 'tidal'],
  [/amazon.*music/i, 'Amazon Music', 'amazon music'],
  [/vlc/i, 'VLC', 'vlc'],
  [/foobar/i, 'foobar2000', 'foobar2000'],
  [/musicbee/i, 'MusicBee', 'musicbee'],
  [/discord/i, 'Discord', 'discord'],
];
const BROWSERS = new Set(['Firefox', 'Chrome', 'Edge', 'Brave', 'Opera']);

function identify(aumid) {
  const id = String(aumid || '');
  for (const [re, name, proc] of KNOWN) if (re.test(id)) return { name, proc };
  const base = id.split('!').pop().replace(/\.exe$/i, '').split('.').pop() || id;
  return { name: base.charAt(0).toUpperCase() + base.slice(1), proc: base.toLowerCase() };
}

// Host snapshot → plain state. Positions are extrapolated to the moment of the read.
function normalize(raw) {
  const at = raw?.at || Date.now();
  const apps = Array.isArray(raw?.apps) ? raw.apps : [];
  const sessions = (Array.isArray(raw?.sessions) ? raw.sessions : []).map(s => {
    const { name, proc } = identify(s.app);
    const status = STATUS[s.status] || String(s.status || 'unknown').toLowerCase();
    const duration = s.end > s.start ? s.end - s.start : null;
    let position = Number.isFinite(s.position) ? s.position - (s.start || 0) : null;
    if (position !== null && status === 'playing' && s.updated) position += Math.max(0, (at - s.updated) / 1000) * (s.rate || 1);
    if (position !== null && duration) position = Math.min(position, duration);
    const audio = apps.filter(a => String(a.process).toLowerCase() === proc);
    return {
      id: s.app, app: name, process: audio.length ? audio[0].process : null, browser: BROWSERS.has(name),
      title: s.title || '', artist: s.artist || s.albumArtist || '', album: s.album || '', subtitle: s.subtitle || '',
      type: String(s.type || '').toLowerCase(), status, position: position === null ? null : Math.max(0, position), duration,
      shuffle: typeof s.shuffle === 'boolean' ? s.shuffle : null, repeat: s.repeat ? REPEAT[s.repeat] || String(s.repeat).toLowerCase() : null,
      can: s.can || {}, current: !!s.current,
      volume: audio.length ? audio[0].volume : null, muted: audio.length ? audio.every(a => a.muted) : null,
    };
  });
  const system = raw?.system || {};
  return { at, sessions, system: { volume: Number.isFinite(system.volume) ? system.volume : null, muted: typeof system.muted === 'boolean' ? system.muted : null }, apps };
}

const playing = st => st.sessions.filter(s => s.status === 'playing');

// Which session the user means. { session } or { clarify: [names] } or { none: reason }.
function pickSession(st, { app, action } = {}) {
  const all = st.sessions;
  if (app) {
    const want = String(app).toLowerCase();
    const hits = all.filter(s => s.app.toLowerCase() === want || s.id.toLowerCase().includes(want) || (want === 'youtube' && s.browser));
    if (!hits.length) return { none: `${app} isn't playing anything I can see` };
    if (hits.length === 1) return { session: hits[0] };
    return pickSession({ ...st, sessions: hits }, { action });
  }
  if (!all.length) return { none: 'nothing is playing' };
  const on = playing(st);
  if (action === 'play') {
    if (on.length) return { session: on.find(s => s.current) || on[0], already: true };
    const cur = all.find(s => s.current);
    if (cur) return { session: cur };
    const paused = all.filter(s => s.status === 'paused');
    if (paused.length === 1) return { session: paused[0] };
    if (paused.length > 1) return { clarify: paused.map(s => s.app) };
    return { session: all[0] };
  }
  if (on.length === 1) return { session: on[0] };
  if (on.length > 1) {
    const cur = on.find(s => s.current);
    if (cur) return { session: cur };
    return { clarify: on.map(s => s.app) };
  }
  return { session: all.find(s => s.current) || all[0] };
}

const sameTrack = (a, b) => a && b && a.title === b.title && a.artist === b.artist;
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

function createMediaService({ request, keys, timeoutMs = 2500, verifyMs = 1800, pollMs = 150, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = {}) {
  const call = (cmd, args) => Promise.race([
    request(cmd, args, { timeoutMs }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('media host timed out')), timeoutMs)),
  ]);

  async function state() { return normalize(await call('state')); }

  // Read until check(after) is true or verifyMs runs out. Returns the last state read.
  async function settle(check) {
    const t0 = Date.now();
    let st;
    for (;;) {
      await sleep(pollMs);
      st = await state();
      if (check(st)) return { st, ok: true };
      if (Date.now() - t0 >= verifyMs) return { st, ok: false };
    }
  }

  const find = (st, id) => st.sessions.find(s => s.id === id);

  // Media-key fallback when the host is unavailable. Unverified by design.
  const KEY = { play: 'playpause', pause: 'playpause', toggle: 'playpause', stop: 'stop', next: 'next', prev: 'prev', mute: 'mute', unmute: 'mute' };
  async function viaKeys(cmd, why) {
    let key = KEY[cmd.action];
    let presses = 1;
    if (cmd.action === 'volume' && cmd.by) { key = cmd.by > 0 ? 'volup' : 'voldown'; presses = Math.max(1, Math.round(Math.abs(cmd.by) / 0.02)); }
    if (!key || !keys) return { ok: false, action: cmd.action, message: `I can't do that right now: ${why}` };
    for (let i = 0; i < presses; i++) await keys(key);
    log(`media: host unavailable (${why}); sent ${key} x${presses} via sysmon, unverified`);
    return { ok: true, action: cmd.action, verified: false, via: 'keys' };
  }

  // cmd: { action, app?, to?, by?, on?, mode?, target? }
  //   play pause toggle stop next prev | seek {to|by seconds} | volume {set|by 0..1, target:'system'|'app'}
  //   mute/unmute {target} | shuffle {on} | repeat {mode: none|track|list} | queue (unsupported)
  async function act(cmd) {
    const trace = [];
    let before;
    try { before = await state(); } catch (err) { return viaKeys(cmd, err.message); }
    trace.push(`read: ${before.sessions.map(s => `${s.app} ${s.status} "${s.title}"`).join(', ') || 'no sessions'}; system volume ${before.system.volume}`);

    if (cmd.action === 'queue') return { ok: false, unsupported: true, action: 'queue', message: "Windows media controls don't expose the queue, so I can't see or change it" };

    // System volume and mute need no session unless an app is named.
    const appVolume = cmd.target === 'app' || (cmd.app && ['volume', 'mute', 'unmute'].includes(cmd.action));
    if (['volume', 'mute', 'unmute'].includes(cmd.action) && !appVolume) {
      // "turn it up" with Windows already at 100%: the playing app's own volume is what still has room
      const on = pickSession(before, { action: 'volume' }).session;
      if (cmd.action === 'volume' && cmd.by > 0 && before.system.volume >= 0.995 && on?.status === 'playing' && on.process && on.volume !== null && on.volume < 0.995) {
        trace.push(`system at 100%; raising ${on.app} instead`);
        return sessionVolume(cmd, on, before, trace);
      }
      return systemVolume(cmd, before, trace);
    }

    const pick = pickSession(before, { app: cmd.app, action: cmd.action === 'toggle' ? 'play' : cmd.action });
    if (pick.clarify) return { ok: false, clarify: pick.clarify, action: cmd.action, trace };
    if (pick.none) return { ok: false, none: true, action: cmd.action, message: pick.none, state: before, trace };
    const s = pick.session;
    trace.push(`target: ${s.app} (${s.status})`);

    if (appVolume) return sessionVolume(cmd, s, before, trace);

    let action = cmd.action, value, check, retry = true;
    if (action === 'toggle') action = s.status === 'playing' ? 'pause' : 'play';
    switch (action) {
      case 'play':
        if (s.status === 'playing') return { ok: true, noop: true, action, session: s, state: before, trace };
        check = a => find(a, s.id)?.status === 'playing'; break;
      case 'pause':
        if (s.status !== 'playing') return { ok: true, noop: true, action, session: s, state: before, trace };
        check = a => find(a, s.id)?.status !== 'playing'; break;
      case 'stop':
        if (['stopped', 'closed'].includes(s.status)) return { ok: true, noop: true, action, session: s, state: before, trace };
        check = a => !find(a, s.id) || find(a, s.id).status !== 'playing'; break;
      case 'next':
      case 'prev':
        retry = false;   // a late update would turn a retry into a double skip
        check = a => { const n = find(a, s.id); return !n || !sameTrack(n, s) || (action === 'prev' && n.position !== null && n.position < 3 && (s.position || 0) >= 3); };
        break;
      case 'seek': {
        if (!s.can.seek) return { ok: false, unsupported: true, action, session: s, message: `${s.app} doesn't allow seeking here`, trace };
        const from = s.position || 0;
        let to = cmd.to !== undefined ? cmd.to : from + (cmd.by || 0);
        to = Math.max(0, s.duration ? Math.min(to, s.duration - 1) : to);
        value = to;
        check = a => { const n = find(a, s.id); return n && near(n.position, to, 3); };
        break;
      }
      case 'shuffle':
        if (!s.can.shuffle || s.shuffle === null) return { ok: false, unsupported: true, action, session: s, message: `${s.app} doesn't let Windows change shuffle`, trace };
        value = cmd.on === undefined ? !s.shuffle : !!cmd.on;
        if (s.shuffle === value) return { ok: true, noop: true, action, value, session: s, state: before, trace };
        check = a => find(a, s.id)?.shuffle === value; break;
      case 'repeat':
        if (!s.can.repeat || s.repeat === null) return { ok: false, unsupported: true, action, session: s, message: `${s.app} doesn't let Windows change repeat`, trace };
        value = cmd.mode || 'track';
        if (s.repeat === value) return { ok: true, noop: true, action, value, session: s, state: before, trace };
        check = a => find(a, s.id)?.repeat === value; break;
      default:
        return { ok: false, action, message: `Unknown media action ${action}`, trace };
    }
    const can = { play: s.can.play || s.can.playpause, pause: s.can.pause || s.can.playpause }[action] ?? s.can[action];
    if (can === false) return { ok: false, unsupported: true, action, session: s, message: `${s.app} doesn't allow ${WORD[action] || action} right now`, trace };

    const hostValue = action === 'repeat' ? { none: 0, track: 1, list: 2 }[value] : value;
    for (let attempt = 1; attempt <= (retry ? 2 : 1); attempt++) {
      let accepted;
      // a browser accepts "stop" from Windows but never stops (only pauses): ask for the pause it can do
      const hostAction = action === 'stop' && s.browser && s.can.pause !== false ? 'pause' : action;
      try { accepted = await call('control', { app: s.id, action: hostAction, value: hostValue }); } catch (err) { trace.push(`attempt ${attempt}: ${err.message}`); accepted = false; }
      trace.push(`attempt ${attempt}: ${action}${value !== undefined ? ' ' + value : ''} → ${accepted ? 'accepted' : 'refused'}`);
      if (!accepted && !retry) break;
      if (!accepted) continue;
      const r = await settle(check);
      trace.push(`verify: ${r.ok ? 'ok' : 'no change'}`);
      if (r.ok) return { ok: true, action, value, session: find(r.st, s.id) || s, state: r.st, trace };
      if (!retry) return { ok: false, action, value, session: s, state: r.st, message: `${s.app} didn't ${WORD[action] || action}`, trace };
    }
    log('media: ' + trace.join(' | '));
    return { ok: false, action, value, session: s, message: `${s.app} didn't ${WORD[action] || action}`, trace };
  }

  async function systemVolume(cmd, before, trace) {
    const cur = before.system.volume;
    if (cur === null) return viaKeys(cmd, 'system volume unreadable');
    const args = {};
    let check;
    if (cmd.action === 'volume') {
      const to = Math.round(Math.max(0, Math.min(1, cmd.set !== undefined ? cmd.set : cur + (cmd.by || 0))) * 100) / 100;
      if (Math.abs(to - cur) < 0.005 && !before.system.muted) return { ok: true, noop: true, action: 'volume', value: to, target: 'system', state: before, trace };
      args.set = to;
      if (before.system.muted && to > cur) args.mute = false;   // turning it up should be heard
      check = a => near(a.system.volume, to, 0.015);
    } else {
      const want = cmd.action === 'mute' ? (cmd.on === undefined ? true : !!cmd.on) : false;
      if (before.system.muted === want) return { ok: true, noop: true, action: cmd.action, target: 'system', state: before, trace };
      args.mute = want;
      check = a => a.system.muted === want;
    }
    return applyVolume(cmd, args, check, 'system', trace);
  }

  async function sessionVolume(cmd, s, before, trace) {
    if (!s.process) return { ok: false, unsupported: true, action: cmd.action, session: s, message: `${s.app} has no audio session I can adjust`, trace };
    const app = () => before.apps.find(a => String(a.process).toLowerCase() === s.process.toLowerCase());
    const args = { app: s.process };
    let check;
    const read = a => a.apps.find(x => String(x.process).toLowerCase() === s.process.toLowerCase());
    if (cmd.action === 'volume') {
      const cur = app()?.volume ?? 1;
      const to = Math.round(Math.max(0, Math.min(1, cmd.set !== undefined ? cmd.set : cur + (cmd.by || 0))) * 100) / 100;
      args.set = to;
      check = a => near(read(a)?.volume, to, 0.015);
    } else {
      const want = cmd.action === 'mute' ? (cmd.on === undefined ? true : !!cmd.on) : false;
      args.mute = want;
      check = a => read(a)?.muted === want;
    }
    const r = await applyVolume(cmd, args, check, 'app', trace);
    return { ...r, session: s };
  }

  async function applyVolume(cmd, args, check, target, trace) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await call('volume', args); } catch (err) { trace.push(`volume attempt ${attempt}: ${err.message}`); continue; }
      const r = await settle(check);
      trace.push(`volume attempt ${attempt}: ${JSON.stringify(args)} → ${r.ok ? 'ok' : 'no change'}`);
      if (r.ok) return { ok: true, action: cmd.action, value: args.set, target, state: r.st, trace };
    }
    log('media: ' + trace.join(' | '));
    return { ok: false, action: cmd.action, target, message: "the volume didn't change", trace };
  }

  return { state, act, pickSession };
}

const WORD = { play: 'play', pause: 'pause', stop: 'stop', next: 'skip', prev: 'go back', seek: 'seek', shuffle: 'change shuffle', repeat: 'change repeat' };

module.exports = { createMediaService, normalize, pickSession, identify };
