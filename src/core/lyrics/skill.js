// Lyrics fast path: a recognised lyrics request is answered here, before any model call, so the text on screen
// is exactly what LRCLIB returned (a small model would drop or invent lines).
// handle(text, { source }) -> null (not a lyrics request) | { reply, record, tool, ok }
//   reply  = the one short sentence that is spoken
//   record = what the chat shows: the full lyrics for "lyrics for X", the answer for a lookup
const { parse, target } = require('./intent');
const { named: songName } = require('../media/ytmusic');

const TOOL = 'lyrics';
const named = r => `“${r.title}”${r.artist ? ` by ${r.artist}` : ''}`;
const quote = s => `“${String(s).replace(/[“”]/g, '"')}”`;
const say = (reply, ok = true) => ({ reply, record: reply, tool: TOOL, ok });

// After "which song?" or a miss, a short bare reply ("Entombed", "Risk by Deftones") is the song, not a new topic:
// without this it would go to the model, which makes lyrics up.
const FOLLOW_MS = 30000;
const COMMANDISH = /^(?:play|pause|resume|skip|next|previous|prev|stop|volume|turn|set|open|queue|add|remove|what|who|how|why|when|where|show|tell|can|could|please|jarvis|hey|ok|okay|yes|no|thanks|thank|never|cancel)\b/i;

// "play that song" right after lyrics were shown (or a song was named from a line) means that song
const PLAY_THAT = /^(?:(?:hey )?jarvis,? )?(?:(?:can|could|would) you )?(?:please )?(?:play|put on|start|go ahead and play)\s+(?:that|it|this|the same)(?:\s+(?:song|one|track))?(?:\s+please)?\s*[?.!]*$/i;
const LAST_MS = 15 * 60 * 1000;

function createLyricsSkill({ lyrics, ytm = null, getConfig = () => ({}), now = Date.now }) {
  let askedAt = 0;
  let last = null;   // the song whose lyrics were just shown: { title, artist, at }
  const remember = rec => { last = { title: String(rec.title).replace(/^.+?\s+[-–—]\s+/, ''), artist: rec.artist, at: now() }; };

  async function playLast() {
    const r = await ytm.play(`${last.title} by ${last.artist}`);
    if (!r.ok) return say(r.message || `I couldn't play ${last.title}.`, false);
    if (!r.started) return say(r.message, true);
    return say(`Playing ${songName(r.item)}.`);
  }
  const off = () => getConfig()?.online?.enabled === false || getConfig()?.online?.lyrics === false;

  async function show(intent) {
    const r = await lyrics.get(intent.current ? { current: true } : { title: intent.title, artist: intent.artist });
    if (!r.ok) {
      if (r.reason === 'nothing-playing') return say("Nothing is playing, so tell me which song, like “lyrics for Risk by Deftones”.", false);
      if (r.reason === 'instrumental') return say(`${named(r.rec)} is an instrumental, so it has no lyrics.`);
      if (r.reason === 'not-found') return say(`I couldn't find lyrics for ${named(r.want)}.`, false);
      return say(`I couldn't reach the lyrics service${r.message ? ` (${r.message})` : ''}.`, false);
    }
    remember(r.rec);
    const head = `${named(r.rec)}${r.rec.album ? ` (${r.rec.album})` : ''}`;
    const record = `Lyrics for ${head}\n\n\`\`\`\n${r.rec.text.replace(/`{3,}/g, "'''")}\n\`\`\`\nSource: LRCLIB`;
    return { reply: `The lyrics to ${r.rec.title} are on screen.`, record, tool: TOOL, ok: true };
  }

  function answer(r, phrase, wantNext) {
    if (r.ok) {
      remember(r.rec);
      const head = `That's ${named(r.rec)}.`;
      if (wantNext) return r.next ? say(`${head} After “${r.line}” comes: ${quote(r.next)}.`) : say(`${head} That's the last line, nothing comes after it.`);
      return say(r.next ? `${head} The next line is ${quote(r.next)}.` : head);
    }
    if (r.reason === 'no-token') return say(r.message, false);
    if (r.reason === 'unconfirmed') return say(`The closest I found is ${named(r.guess)}, but I couldn't confirm those words in its lyrics, so I won't say it's that.`, false);
    if (r.reason === 'not-found') return say(`I couldn't find a song with ${quote(phrase)} in it.`, false);
    return say(`I couldn't reach the lyrics service${r.message ? ` (${r.message})` : ''}.`, false);
  }

  async function handle(text) {
    if (ytm && last && now() - last.at < LAST_MS && PLAY_THAT.test(String(text).trim())) {
      askedAt = 0;
      try { return await playLast(); } catch (err) { return say(`I couldn't start it: ${err.message}`, false); }
    }
    let intent = parse(text);
    const following = !intent && askedAt && now() - askedAt < FOLLOW_MS && String(text).trim().split(/\s+/).length <= 6 && !COMMANDISH.test(String(text).trim());
    askedAt = 0;
    if (following) intent = target(text);
    if (!intent) return null;
    if (off()) return say('Online lookups are off, so I can only use lyrics I already saved.', false);
    try {
      if (intent.kind === 'show') {
        const r = await show(intent);
        if (!r.ok && /^(?:Nothing is playing|I couldn't find lyrics)/.test(r.reply)) askedAt = now();
        return r;
      }
      if (intent.kind === 'next') return answer(await lyrics.nextLine(intent.phrase), intent.phrase, true);
      return answer(await lyrics.byLyric(intent.phrase), intent.phrase, false);
    } catch (err) {
      return say(`The lyrics lookup failed: ${err.message}`, false);
    }
  }

  return { handle };
}

module.exports = { createLyricsSkill };
