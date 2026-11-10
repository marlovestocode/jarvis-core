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

function createMediaSkill({ service, ytm = null, now = Date.now }) {
  let pending = null;   // a question JARVIS asked: { intent, options, at }

  function ask(intent, options, tool) {
    pending = { intent, options, at: now() };
    const q = clarifyQuestion(options);
    return { reply: q, record: q, tool, ok: true, clarify: options };
  }
  const say = (reply, ok = true, tool = 'youtube_music', record = reply) => ({ reply, record, tool, ok });

  async function handle(text, { source = 'text' } = {}) {
    const voice = source === 'voice';
    let intent = parse(text);
    if (!intent && pending && now() - pending.at < CLARIFY_MS) {
      const app = parseApp(text);
      if (app && pending.options.some(o => o.toLowerCase() === app.toLowerCase())) intent = { ...pending.intent, app };
    }
    pending = null;
    if (!intent) return null;

    if (intent.kind === 'unsupported') return { reply: intent.message, record: intent.message, tool: 'media_control', ok: false };
    try {
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
