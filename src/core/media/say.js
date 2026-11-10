// What JARVIS says about media. Voice gets words that read well aloud; text gets compact forms.
// Answers lead with the fact asked for and stop there.

function clock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function spokenDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const out = [];
  if (h) out.push(part(h, 'hour'));
  if (m) out.push(part(m, 'minute'));
  if (r || !out.length) out.push(part(r, 'second'));
  return out.join(' ');
}

const dur = (sec, voice) => (voice ? spokenDuration(sec) : clock(sec));
const pct = v => `${Math.round(v * 100)}%`;
const spokenPct = v => `${Math.round(v * 100)} percent`;
const quoteTitle = (t, voice) => (voice ? t : `“${t}”`);

// "Song by Artist" with whatever the source gives.
function what(s, voice) {
  if (!s.title) return `something in ${s.app}`;
  return s.artist ? `${quoteTitle(s.title, voice)} by ${s.artist}` : quoteTitle(s.title, voice);
}

function nowPlaying(s, voice) {
  if (!s) return "Nothing's playing.";
  const lead = s.status === 'playing' ? '' : s.status === 'paused' ? 'Paused: ' : `${cap(s.status)}: `;
  const parts = [`${lead}${what(s, voice)}`];
  if (s.album && s.album !== s.title) parts[0] += `, from ${s.album}`;
  parts[0] += '.';
  const where = [s.browser ? `In ${s.app}` : `On ${s.app}`];
  if (s.duration && s.position !== null) where.push(voice ? `${dur(s.position, true)} of ${dur(s.duration, true)}` : `${clock(s.position)} of ${clock(s.duration)}`);
  parts.push(where.join(', ') + '.');
  return parts.join(' ');
}

const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// Answer a query from a fresh state. q: { what, app? }.
function answer(q, st, pick, voice) {
  const s = pick;
  switch (q.what) {
    case 'now': return nowPlaying(s, voice);
    case 'artist':
      if (!s) return "Nothing's playing.";
      return s.artist ? `${s.artist}.` : `${s.app} doesn't say who it's by.`;
    case 'album':
      if (!s) return "Nothing's playing.";
      return s.album ? `${s.album}.` : `${s.app} doesn't give an album for this.`;
    case 'time':
      if (!s) return "Nothing's playing.";
      if (!s.duration || s.position === null) return `${s.app} doesn't report the position.`;
      return `${dur(s.duration - s.position, voice)} left, of ${dur(s.duration, voice)}.`;
    case 'volume': {
      const sys = st.system;
      if (sys.volume === null) return "I can't read the volume.";
      let out = sys.muted ? `Muted, at ${voice ? spokenPct(sys.volume) : pct(sys.volume)}.` : `${voice ? cap(spokenPct(sys.volume)) : pct(sys.volume)}.`;
      if (s && s.volume !== null && s.volume < 0.995) out += ` ${s.app} is at ${voice ? spokenPct(s.volume) : pct(s.volume)}.`;
      return out;
    }
    case 'app':
      if (!s) return "Nothing's playing.";
      return `${s.app}.`;
    case 'next':
      return "Windows doesn't share the queue, so I can't see what's next.";
    default: return nowPlaying(s, voice);
  }
}

// Text-chat acknowledgement for a control that worked. Voice says nothing: the user hears it.
function ack(r) {
  if (r.via === 'keys') return { play: 'Sent play/pause.', pause: 'Sent play/pause.', toggle: 'Sent play/pause.', stop: 'Sent stop.', next: 'Sent next.', prev: 'Sent previous.', mute: 'Sent mute.', unmute: 'Sent mute.', volume: 'Sent volume key.' }[r.action] + " (Can't confirm: media host is off.)";
  if (r.noop) {
    return { play: 'Already playing.', pause: 'Already paused.', stop: 'Already stopped.', mute: 'Already muted.', unmute: 'Not muted.', volume: `Already at ${pct(r.value ?? 0)}.`, shuffle: `Shuffle already ${r.value ? 'on' : 'off'}.`, repeat: `Repeat already ${r.value}.` }[r.action] || 'Done.';
  }
  switch (r.action) {
    case 'play': return 'Playing.';
    case 'pause': return 'Paused.';
    case 'stop': return 'Stopped.';
    case 'next': return r.session?.title ? `Next: ${what(r.session, false)}.` : 'Skipped.';
    case 'prev': return r.session?.title ? `Back: ${what(r.session, false)}.` : 'Previous.';
    case 'seek': return `At ${clock(r.value)}.`;
    case 'volume': return r.target === 'app' && r.session ? `${r.session.app} ${pct(r.value)}.` : `Volume ${pct(r.value)}.`;
    case 'mute': return 'Muted.';
    case 'unmute': return 'Unmuted.';
    case 'shuffle': return `Shuffle ${r.value ? 'on' : 'off'}.`;
    case 'repeat': return r.value === 'none' ? 'Repeat off.' : `Repeat ${r.value === 'track' ? 'this track' : 'all'}.`;
    default: return 'Done.';
  }
}

// Spoken/text line when a control failed, was refused, or is not possible.
function failure(r) {
  const why = r.message || "it didn't respond";
  return cap(why.replace(/\.$/, '')) + '.';
}

function clarifyQuestion(names) {
  const uniq = [...new Set(names)];
  return uniq.length === 2 ? `${uniq[0]} or ${uniq[1]}?` : `Which one: ${uniq.slice(0, -1).join(', ')} or ${uniq.at(-1)}?`;
}

// One line for the system prompt so the model always knows what is playing.
function promptLine(st) {
  const on = st.sessions.filter(s => s.status === 'playing');
  const list = (on.length ? on : st.sessions.filter(s => s.current)).slice(0, 2);
  const vol = st.system.volume !== null ? ` System volume ${pct(st.system.volume)}${st.system.muted ? ' (muted)' : ''}.` : '';
  if (!list.length) return `Media: nothing playing.${vol}`;
  return 'Media: ' + list.map(s => `${s.status} ${what(s, false)}${s.album ? ` (${s.album})` : ''} in ${s.app}${s.duration && s.position !== null ? `, ${clock(s.position)}/${clock(s.duration)}` : ''}`).join('; ') + '.' + vol;
}

module.exports = { answer, ack, failure, clarifyQuestion, promptLine, nowPlaying, clock, spokenDuration };
