// Casual media commands → one exact intent, without a model call.
// parse(text) → null (not a media command) |
//   { kind: 'control', action, app?, to?, by?, set?, on?, mode?, target? } |
//   { kind: 'query', what: 'now'|'artist'|'album'|'time'|'volume'|'app'|'next' } |
//   { kind: 'unsupported', message }
// Patterns match the whole (cleaned) utterance so ordinary questions never get hijacked.

const { variants } = require('../voice/understand');

const APPS = [
  [/\bspotify\b/, 'Spotify'], [/\b(google )?chrome\b/, 'Chrome'], [/\b(microsoft )?edge\b/, 'Edge'], [/\bfirefox\b/, 'Firefox'],
  [/\bbrave\b/, 'Brave'], [/\bopera\b/, 'Opera'], [/\byoutube( music)?\b/, 'YouTube'], [/\bvlc\b/, 'VLC'], [/\b(windows )?media player\b/, 'Media Player'],
  [/\bapple music\b/, 'Apple Music'], [/\btidal\b/, 'TIDAL'], [/\bamazon music\b/, 'Amazon Music'], [/\bfoobar\b/, 'foobar2000'], [/\bmusicbee\b/, 'MusicBee'],
];

// "songs you think I'd like" asks for JARVIS's own picks: the brain chooses them, so it is never a literal search
const TASTE = /\b(?:(?:\d+|a few|some|several|a couple of|couple|two|three|four|five|six|seven|eight|nine|ten) (?:\w+ ){0,3}(?:songs|tracks)\b|random (?:\w+ ){0,3}(?:songs?|tracks?)\b|you (?:think|thought|know|reckon)|you'?d|you would|i'?d (?:like|enjoy|love)|i would (?:like|enjoy|love)|i (?:might|may|will) (?:like|enjoy|love)|surprise|your (?:picks?|choice|taste)|secret(?:ly)?|(?:few|some|couple of|\d+|three|four|five|six) (?:songs|tracks) (?:for|that|i|you))\b/;

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90, half: 0.5, 'a couple': 2, 'a few': 3 };
const num = w => (w === undefined ? undefined : /^\d+(\.\d+)?$/.test(w) ? Number(w) : NUM[w]);
const NUMWORD = '\\d+(?:\\.\\d+)?|a couple|a few|forty five|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half';

function clean(text) {
  let t = String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9:%.' ]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  t = t.replace(/^(?:(?:hey|ok|okay|yo) )?jarvis\b ?/, '');
  t = t.replace(/^(?:please |can you |could you |would you |will you |go ahead and |just )+/, '').replace(/(?: please| for me| now| right now| thanks| thank you)+$/, '');
  return t.trim();
}

function takeApp(t) {
  for (const [re, name] of APPS) {
    if (re.test(t)) {
      const rest = t.replace(new RegExp(String.raw`\s*\b(?:on|in|from)?\s*(?:the\s+)?` + re.source.replace(/^\\b|\\b$/g, '') + String.raw`\b(?:'s)?`), ' ').replace(/\s+/g, ' ').trim();
      return { app: name, rest };
    }
  }
  return { app: undefined, rest: t };
}

const MEDIA_NOUN = '(?:it|this|that|the (?:music|song|track|video|podcast|audio|episode|media|playback)|music|song|track|video|media|audio|playback|the player)';
const AMOUNT_SMALL = /\b(a (?:little )?bit|a little|a tad|a touch|slightly|a smidge|little bit|just a bit)\b/;
const AMOUNT_BIG = /\b(a lot|way|loads|much|a bunch)\b/;

function amount(t) { return AMOUNT_SMALL.test(t) ? 0.05 : AMOUNT_BIG.test(t) ? 0.2 : 0.1; }

function seconds(n, unit) {
  const v = num(n);
  if (v === undefined) return undefined;
  return /^min/.test(unit) ? v * 60 : /^h/.test(unit) ? v * 3600 : v;
}

// "1:30", "90 seconds", "2 minutes", "1 minute 20 seconds", "2 minutes and 10 seconds"
function timeAt(s) {
  let m = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  m = s.match(new RegExp(`^(${NUMWORD}) (minutes?|mins?)(?: and)?(?: (${NUMWORD}) (?:seconds?|secs?))?$`));
  if (m) return seconds(m[1], 'min') + (m[3] ? num(m[3]) : 0);
  m = s.match(new RegExp(`^(${NUMWORD}) (seconds?|secs?)$`));
  if (m) return num(m[1]);
  return undefined;
}

// loose: spoken input. When the strict grammar finds nothing, try rewrites of the same words (fillers and hedges removed,
// indirect asks like "it's too quiet", misheard command words) and keep the first the strict grammar accepts whole.
// Only controls and questions come back this way, never a "play <name>" search, so a wrong guess stays a reversible media control.
function parse(text, { loose = false } = {}) {
  const strict = parseStrict(text);
  // "play something else" is a request to change the song, not a search for a song called "something else"
  const vague = strict?.kind === 'find' && /^(?:something|anything|a different|different|another|some other|a new|it again|that again|this again|it back|that back|it one more time)\b/.test(strict.query);
  if ((strict && !vague) || !loose) return strict;
  const raw = clean(text);
  if (!raw) return null;
  for (const v of variants(raw)) {
    const r = parseStrict(v.text);
    if (r && (r.kind === 'control' || r.kind === 'query') && !(r.kind === 'control' && r.action === 'queue')) {
      return { ...r, via: v.how, ...(v.loose && r.action !== 'stop' ? { loose: true } : {}) };
    }
  }
  return strict;
}

function parseStrict(text) {
  const raw = clean(text);
  if (!raw || raw.split(' ').length > 16) return null;
  const { app, rest } = takeApp(raw);
  const t = rest;
  const C = (action, extra = {}) => ({ kind: 'control', action, ...(app ? { app } : {}), ...extra });
  let m;

  // ---- questions about what is playing ----
  if (/^(?:what'?s|what is|whats) (?:playing|on|this|this (?:song|track|tune|video|music|podcast)|the (?:song|track|music|video)(?: playing| on)?|currently playing|now playing)(?: right now| now)?$/.test(t)
    || /^what (?:song|track|music|tune|video) (?:is|'s) (?:this|that|playing|on)(?: right now| now)?$/.test(t)
    || /^what (?:song|track|music|tune|video) is this$/.test(t)
    || /^what am i (?:listening to|hearing|watching)$/.test(t) || /^(?:name|identify) (?:this|that) (?:song|track|tune)$/.test(t)
    || /^(?:now playing|what'?s the song)$/.test(t) || /^is (?:anything|something|music|it) (?:playing|paused)$/.test(t)
    || /^is (?:the )?(?:music|song|video) (?:playing|paused)$/.test(t)) return { kind: 'query', what: 'now', ...(app ? { app } : {}) };
  if (/^who(?:'s| is) (?:this|singing|the artist|that|singing this|this artist|this by)$/.test(t) || /^who (?:sings|sang|made|performs|is singing|wrote) (?:this|that|it)(?: song| track)?$/.test(t)
    || /^(?:what|which) (?:artist|band|singer|channel) is (?:this|that|playing)$/.test(t) || /^who is this song by$/.test(t)) return { kind: 'query', what: 'artist', ...(app ? { app } : {}) };
  if (/^(?:what|which) album(?: is (?:this|it|that)(?: (?:from|on))?| is this song (?:from|on))?$/.test(t)) return { kind: 'query', what: 'album', ...(app ? { app } : {}) };
  if (/^how (?:long|much)(?: time)? (?:is )?(?:left|remaining)(?: (?:in|on) (?:this|the) (?:song|track|video|episode))?$/.test(t)
    || /^how far (?:in|into) (?:is it|this|the song|the track|this song|are we|am i)$/.test(t) || /^how long is (?:this|the) (?:song|track|video|episode)$/.test(t)) return { kind: 'query', what: 'time', ...(app ? { app } : {}) };
  if (/^(?:what'?s|what is) the volume(?: at| level)?$/.test(t) || /^how loud is it$/.test(t) || /^volume level$/.test(t)) return { kind: 'query', what: 'volume', ...(app ? { app } : {}) };
  if (/^(?:what|which) (?:app|player|program) is (?:playing|that|this)(?: in| on| from)?$/.test(t) || /^where is (?:this|that|the music) (?:playing|coming) from$/.test(t)) return { kind: 'query', what: 'app' };
  if (/^(?:what'?s|what is|whats) (?:up next|next up|playing next|coming up next|next in the queue|in the queue|next song|the next song)$/.test(t) || /^what (?:song|track) is next$/.test(t)
    || /^(?:show|read|tell) (?:me )?(?:the|my) queue$/.test(t) || /^what'?s (?:in|on) (?:the|my) queue$/.test(t)) return { kind: 'query', what: 'next' };

  // ---- queue (YouTube Music through the extension; other players cannot) ----
  if (/^(?:clear|empty|wipe)(?: out)? (?:the |my )?queue$/.test(t) || /^clear queue$/.test(t)) return { kind: 'control', action: 'queue', op: 'clear' };
  if (/^(?:remove|delete|take out|drop|skip) (?:the )?next (?:song|track|one)(?: (?:from|in|out of) (?:the )?queue)?$/.test(t) || /^remove (?:that|it) from (?:the )?queue$/.test(t))
    return { kind: 'control', action: 'queue', op: 'remove-next' };
  if ((m = t.match(/^(?:add|put|throw|stick) (.+?) (?:to|in|on|into|at the end of) (?:the |my )?queue$/)) || (m = t.match(/^queue(?: up)? (.+)$/)))
    return /^(?:it|this|that|this song|that song)$/.test(m[1]) || TASTE.test(m[1]) ? null : { kind: 'find', mode: 'end', query: m[1], ...(app ? { app } : {}) };
  if ((m = t.match(/^play (.+?) (?:next|after this(?: one| song)?)$/)) && !/^(?:the|a)$/.test(m[1])) return { kind: 'find', mode: 'next', query: m[1], ...(app ? { app } : {}) };

  // ---- likes ----
  if (/^(?:like|thumbs up|i like|i love|love) (?:this|this song|this one|it|that|the song|this track)$/.test(t) || /^(?:like it|thumbs up)$/.test(t)) return { kind: 'control', action: 'like', value: 'LIKE' };
  if (/^(?:dislike|thumbs down|i hate|i don'?t like) (?:this|this song|this one|it|that|the song|this track)$/.test(t) || /^thumbs down$/.test(t)) return { kind: 'control', action: 'like', value: 'DISLIKE' };
  if (/^(?:unlike|remove (?:the|my) (?:like|dislike) (?:on|from)) (?:this|this song|it)$/.test(t) || /^unlike$/.test(t)) return { kind: 'control', action: 'like', value: 'INDIFFERENT' };

  // ---- transport ----
  if (new RegExp(`^(?:pause|pause ${MEDIA_NOUN}|hit pause|press pause)$`).test(t)) return C('pause');
  // bare "stop" also ends a spoken reply; it means the music only when something is playing (loose)
  if (/^(?:stop|stop it)$/.test(t)) return C('stop', { loose: true });
  if (new RegExp(`^(?:play|resume|unpause|continue playing|keep playing|press play|hit play|play ${MEDIA_NOUN}|resume ${MEDIA_NOUN}|start ${MEDIA_NOUN}|unpause ${MEDIA_NOUN}|play again|play music)$`).test(t)) return C('play');
  if (/^(?:play pause|toggle play(?:back)?|play or pause)$/.test(t)) return C('toggle');
  if (new RegExp(`^(?:stop ${MEDIA_NOUN}|stop playing|stop playback|stop the music)$`).test(t)) return C('stop');
  if (/^(?:skip|next|skip it|skip this|skip this (?:one|song|track|video)|next (?:one|song|track|video|episode)|play the next (?:one|song|track)|skip (?:the )?(?:song|track)|skip to the next (?:one|song|track))$/.test(t)) return C('next');
  if (/^(?:previous|prev|go back a (?:song|track)|go back one (?:song|track)|back a (?:song|track)|last (?:song|track)|previous (?:one|song|track|video|episode)|play the (?:previous|last) (?:one|song|track)|go to the previous (?:song|track))$/.test(t)) return C('prev');
  if (/^(?:restart|start over|replay|restart (?:it|this|the (?:song|track|video))|start (?:it|this|the (?:song|track|video)) over|from the (?:top|beginning|start)|play (?:it|this) from the (?:top|beginning|start)|go (?:back )?to the (?:beginning|start))$/.test(t)) return C('seek', { to: 0 });

  // ---- seek ----
  if ((m = t.match(new RegExp(`^(?:go |skip |jump |move |rewind |fast forward |scrub )?(back|backward|backwards|forward|forwards|ahead)(?: by)? (${NUMWORD}) (seconds?|secs?|minutes?|mins?)$`)))) {
    const s = seconds(m[2], m[3]);
    if (s !== undefined) return C('seek', { by: /^back/.test(m[1]) ? -s : s });
  }
  if ((m = t.match(new RegExp(`^(rewind|fast forward|skip ahead|go back|jump back|jump ahead)(?: by)? (${NUMWORD}) (seconds?|secs?|minutes?|mins?)$`)))) {
    const s = seconds(m[2], m[3]);
    if (s !== undefined) return C('seek', { by: /rewind|back/.test(m[1]) ? -s : s });
  }
  if (/^(?:rewind|rewind (?:it|a bit|a little)|go back a (?:bit|little)|back a (?:bit|little)|jump back a bit)$/.test(t)) return C('seek', { by: -10 });
  if (/^(?:fast forward|fast forward (?:it|a bit|a little)|skip ahead|skip ahead a (?:bit|little)|forward a (?:bit|little)|jump ahead a bit)$/.test(t)) return C('seek', { by: 30 });
  if ((m = t.match(/^(?:go|skip|jump|seek|fast forward|rewind|move) to (?:the )?(.+?)(?: mark)?$/)) || (m = t.match(/^(?:play|start) (?:it )?from (.+)$/))) {
    const s = timeAt(m[1]);
    if (s !== undefined) return C('seek', { to: s });
  }

  // ---- volume ----
  const tgt = app ? { target: 'app' } : {};
  if ((m = t.match(/^(?:set (?:the )?volume to|volume(?: to| at)?|set volume|turn (?:the )?volume to|put (?:the )?volume (?:at|to)|turn it to|volume level) (\d{1,3})(?: ?%| percent)?$/))) return C('volume', { set: Math.min(100, +m[1]) / 100, ...tgt });
  if (/^(?:max(?:imum)? volume|volume (?:max|all the way up|full)|full volume|turn it all the way up)$/.test(t)) return C('volume', { set: 1, ...tgt });
  if (/^(?:half volume|volume (?:to )?half(?: way)?|set (?:the )?volume to half)$/.test(t)) return C('volume', { set: 0.5, ...tgt });
  const UP = /^(?:turn (?:it |this |that |the (?:volume|music|sound|song|audio) )?up|turn up (?:the )?(?:volume|music|sound)|volume up|louder|make it louder|crank it(?: up)?|pump it up|raise (?:the )?volume|increase (?:the )?volume|bump (?:it|the volume) up|up the volume|i can'?t hear (?:it|this))\b/;
  const DOWN = /^(?:turn (?:it |this |that |the (?:volume|music|sound|song|audio) )?down|turn down (?:the )?(?:volume|music|sound)|volume down|quieter|softer|make it quieter|lower (?:the )?volume|lower it|decrease (?:the )?volume|bring (?:it|the volume) down|too loud|it'?s too loud)\b/;
  const tail = s => /^(?:\s+(?:a (?:little )?bit|a little|a tad|a touch|slightly|a smidge|little bit|just a bit|a lot|way up|way down|much|a bunch|more|some))*$/.test(s);
  if ((m = t.match(UP)) && tail(t.slice(m[0].length))) return C('volume', { by: amount(t), ...tgt });
  if ((m = t.match(/^(?:a (?:little |bit )?(?:bit )?|slightly |much |a lot )(louder|quieter|softer)$/))) return C('volume', { by: (m[1] === 'louder' ? 1 : -1) * amount(t), ...tgt });
  if ((m = t.match(DOWN)) && tail(t.slice(m[0].length))) return C('volume', { by: -amount(t), ...tgt });
  if ((m = t.match(/^(?:turn (?:it |the volume )?(up|down)|volume (up|down)) by (\d{1,2})(?: ?%| percent)?$/))) return C('volume', { by: ((m[1] || m[2]) === 'up' ? 1 : -1) * (+m[3]) / 100, ...tgt });
  if (new RegExp(`^(?:mute|mute ${MEDIA_NOUN}|mute (?:the )?(?:sound|audio|volume|everything)|sound off)$`).test(t)) return C('mute', tgt);
  if (new RegExp(`^(?:unmute|unmute ${MEDIA_NOUN}|unmute (?:the )?(?:sound|audio|volume|everything)|sound on)$`).test(t)) return C('unmute', tgt);

  // ---- shuffle and repeat ----
  if (/^(?:shuffle|shuffle on|turn on shuffle|turn shuffle on|shuffle (?:it|this|the (?:playlist|album|songs)))$/.test(t)) return C('shuffle', { on: true });
  if (/^(?:shuffle off|turn off shuffle|turn shuffle off|stop shuffling|no shuffle|don'?t shuffle)$/.test(t)) return C('shuffle', { on: false });
  if (/^(?:repeat|loop) (?:this|this (?:one|song|track)|one|the (?:song|track)|song|track)$/.test(t) || /^(?:repeat one|loop it)$/.test(t)) return C('repeat', { mode: 'track' });
  if (/^(?:repeat|loop) (?:all|the (?:playlist|album|queue)|everything|playlist|album)$/.test(t) || /^(?:repeat|loop) on$/.test(t) || /^turn (?:on )?(?:repeat|loop)(?: on)?$/.test(t)) return C('repeat', { mode: 'list' });
  if (/^(?:repeat off|loop off|turn off (?:repeat|loop)|turn (?:repeat|loop) off|stop (?:repeating|looping)|no repeat|don'?t repeat)$/.test(t)) return C('repeat', { mode: 'none' });

  // ---- the user's own playlists: library first. The skill falls back to the catalog for a loose phrase
  // ("play the rock playlist") when nothing in the library matches; "my" makes it a library-only request. ----
  const NOT_NAME =/^(?:the|this|that|a|an|my|it|some|any|music|songs?|tracks?|something|anything|playlists?|queue|album|list)$/;
  // add to a playlist / take it back. "explicit" = the user said "playlist", so a name that matches nothing is an answer, not a different request ("add 5 to my total").
  const THIS = '(?:this|this song|this track|it|that|that song|the current song|the song that\'?s playing|what\'?s playing)';
  if (/^(?:undo|undo (?:that|it|the last (?:one|thing|change|add)|my last (?:change|add))|take (?:that|it) back|revert that)$/.test(t)) return { kind: 'library-undo' };
  if ((m = t.match(new RegExp(`^(?:add|save|put) ${THIS}(?: song| track)? (?:to|in|into|on) (?:the |my |a )?(.+?)( playlist)?$`))) && !NOT_NAME.test(m[1]))
    return { kind: 'library-add', current: true, name: m[1], explicit: !!m[2] };
  if (new RegExp(`^(?:add|save) ${THIS}(?: song| track)?(?: to (?:a|my|the) playlist)?$`).test(t)) return { kind: 'library-add', current: true, name: null, explicit: true };
  if ((m = t.match(/^(?:add|put) (.+?) (?:to|in|into|on) (?:the |my )(.+?)( playlist)?$/)) && !NOT_NAME.test(m[2]) && !new RegExp(`^${THIS}$`).test(m[1]))
    return { kind: 'library-add', songs: [m[1]], name: m[2], explicit: !!m[3] };

  if ((m = t.match(/^(?:play|put on|start playing|start) (.+?) from (?:the |my )(.+?) playlist$/)) && !NOT_NAME.test(m[2]) && !NOT_NAME.test(m[1]))
    return { kind: 'library', mode: 'play', name: m[2], track: m[1], explicit: true };
  if ((m = t.match(/^(?:(shuffle)|play|put on|start playing|start) (?:(my|the) )?(.+?) playlist( on shuffle| shuffled)?$/)) && !NOT_NAME.test(m[3]))
    return { kind: 'library', mode: 'play', name: m[3], shuffle: !!(m[1] || m[4]), explicit: m[2] === 'my', query: `${m[3]} playlist` };
  if ((m = t.match(/^shuffle (?:my |the )(.+)$/)) && !NOT_NAME.test(m[1]))
    return { kind: 'library', mode: 'play', name: m[1], shuffle: true, explicit: false, query: m[1] };
  if ((m = t.match(/^(?:play|put on|start playing) my (.+)$/)) && !NOT_NAME.test(m[1]))
    return { kind: 'library', mode: 'play', name: m[1], explicit: false, query: m[1] };

  // ---- "play <something>": search and play it (YouTube Music) ----
  if ((m = t.match(/^(?:play|put on|start playing|play me|play us) (.+)$/)) && !/^(?:it|this|that|music|again)$/.test(m[1])
    && !/\b(?:game|games|chess|cards|trivia|with me|with us|along|pretend|a joke|dead|nice|fair|dumb)\b/.test(m[1])
    // "songs you think I'd like" asks for JARVIS's own picks: the brain chooses them, not a literal search
    && !TASTE.test(m[1]))
    return { kind: 'find', mode: 'play', query: m[1], ...(app ? { app } : {}) };

  // a bare app name means nothing on its own
  return null;
}

// A one-word answer to a clarifying question ("Spotify").
function parseApp(text) {
  const t = clean(text);
  if (t.split(' ').length > 4) return undefined;
  const { app, rest } = takeApp(t);
  return app && /^(?:(?:the )?(?:one|player|app)|it'?s|that'?s|use|try)?$/.test(rest) ? app : undefined;
}

module.exports = { parse, parseApp, clean, timeAt };
