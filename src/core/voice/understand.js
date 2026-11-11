// Loose spoken commands → the exact phrase the strict media parser (media/intent.js) already understands.
// Speech is transcribed imperfectly and people do not talk like a command line ("uh, could you maybe turn that
// down a little, it's kind of loud", "this song sucks", "turn Wallium to max"). variants(cleaned) yields, in order of
// how little they change the words, rewrites of one utterance; the caller keeps the first that the strict parser
// accepts as a whole utterance. That whole-utterance rule is the safety net: a rewrite can only ever land on a
// command the strict grammar already allows, so a wrong guess is a reversible media control, never a free-text action.
//
// variants(cleaned) → [{ text, how }]   cleaned = intent.clean(transcript): lower case, punctuation gone, no wake word.
// how: 'normalized' (fillers/hedges/synonyms), 'paraphrase' (an indirect way of asking), 'repaired' (a misheard word).

const WAKE = /^(?:(?:hey|ok|okay|yo) )?(?:jarvis|jarvas|jarvus|javis|javaist|jervis|gervais|jarvish)\b[ ,]*/;
const FILLER = /\b(?:uh+|um+|er+|erm|hmm+|ah+|mm+|you know|i mean|sort of|kind of|kinda|basically|actually|honestly|literally|really|maybe|perhaps|probably|just|simply|totally|definitely)\b/g;
const LEAD = /^(?:(?:so|well|okay|ok|alright|all right|right|and|but|also|then|now|hey|oh|ah|yeah|yes|listen|look)\b ?)+/;
const ASK = [
  /^(?:i|we)(?:'d| would) (?:like|love|appreciate)(?: it)?(?: if)? ?(?:you )?(?:to |could |would |can )?/,
  /^(?:i|we) (?:want|need|wanna|gotta|have to) (?:you )?(?:to )?/,
  /^(?:i was|i am|i'm|im) (?:wondering|hoping|thinking) (?:if )?(?:you )?(?:could|can|would|might)? ?(?:possibly )?/,
  /^(?:would|could|can|will) you (?:possibly |please |kindly |mind )?(?:go ahead and )?/,
  /^(?:do me a favou?r(?: and)?|do me a solid and|go ahead and|go ahead|how about you|why don'?t you|why not|let'?s|let us|try to|try and|you should|you can|i'?d like to|i think you should|is it possible to|is there a way to|is there any way you can|any chance you can)\s*/,
  /^(?:i think|i guess|i feel like|i suppose|i believe|let me hear|how about we|what about)\s+/,
];
const TRAIL = /(?: if you (?:can|could|don'?t mind|would|please)| or something| or whatever| for me| for us| please| thanks| thank you| right now| now| man| dude| bro| buddy| sir| my guy| okay| ok| alright| will you| would you| could you| can you| yeah| thanks a lot| i guess| i think| mate| mister| boss)+$/;

// "chrome application" / "the chrome app" → "chrome"
const APP_WORD = /\b(chrome|spotify|edge|firefox|brave|opera|youtube(?: music)?|vlc|tidal|foobar|musicbee|media player) (?:application|app|browser|player|window|tab)\b/g;

// words a transcript gives for a command word (curated from real mis-transcriptions; a generic edit-distance pass handles the long ones)
const HEARD = {
  skit: 'skip', scrip: 'skip', skid: 'skip', skipp: 'skip', skiff: 'skip', skeep: 'skip', skipped: 'skip', skipping: 'skip', skips: 'skip',
  paws: 'pause', paus: 'pause', pores: 'pause', pours: 'pause', pawz: 'pause', paused: 'pause', pausing: 'pause',
  plays: 'play', played: 'play', playing: 'play', plae: 'play',
  moot: 'mute', mutes: 'mute', muted: 'mute', muting: 'mute', newt: 'mute',
  nex: 'next', nexts: 'next',
  wallium: 'volume', valium: 'volume', volumn: 'volume', volum: 'volume', vollum: 'volume', volumes: 'volume', balloon: 'volume', 'volume\'s': 'volume',
  current: 'chrome', crome: 'chrome', chrom: 'chrome', krome: 'chrome', crumb: 'chrome', 'chrome\'s': 'chrome', chromes: 'chrome',
  spotifi: 'spotify', spotted: 'spotify',
  loud: 'louder', lauder: 'louder', louda: 'louder', quiet: 'quieter', quite: 'quieter',
  presents: 'percent', parcent: 'percent', persent: 'percent',
};
const LONG_VOCAB = ['shuffle', 'unshuffle', 'repeat', 'resume', 'unmute', 'rewind', 'restart', 'replay', 'previous', 'quieter', 'louder', 'volume', 'forward', 'backward', 'backwards'];

// verb synonyms → the verb the strict grammar knows
const SYN = [
  [/^(?:start|begin|launch|resume|unpause|continue|play) (?:the |this |that |my )?(?:media|music|song|track|video|audio|playback)$/, 'play'],
  [/^(?:cancel|end|kill|quit|halt|terminate|abort|shut off|switch off) (?=(?:the |this |that |my )?(?:media|music|song|track|video|audio|playback|playing|it|everything)\b)/, 'stop '],
  [/^(?:begin|launch|kick off|fire up|put on|turn on|switch on|restart|get) (?=(?:the |this |that |my )?(?:media|music|song|track|video|audio|playback|playing)\b)/, 'play '],
  [/^(?:next|skip|forward|advance|jump) (?=(?:the |this )?(?:one|song|track|video))/, 'skip '],
  [/^(?:go|move|jump|switch|change) (?:over )?to (?:the )?next (?=(?:one|song|track|video|episode)\b)/, 'next '],
  [/^(?:un ?pause|un-pause) /, 'resume '],
];

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM_RE = /\b(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:a |one )?hundred)\b/g;

function wordNumber(w) {
  w = w.replace(/-/g, ' ');
  if (/^(?:a |one )?hundred$/.test(w)) return 100;
  const [a, b] = w.split(' ');
  if (TENS[a] !== undefined) return TENS[a] + (b ? ONES[b] || 0 : 0);
  return ONES[a];
}

// "turn it down to twenty percent" → "... to 20 percent"; only after to / by / at, so "one more time" stays words
function digits(t) {
  return t.replace(new RegExp(`\\b(to|by|at)\\s+(${NUM_RE.source.slice(2, -2)})(?=\\s*(?:%|percent|per cent)?\\s*$)`, 'g'), (m, p, w) => {
    const n = wordNumber(w);
    return n === undefined ? m : `${p} ${n}`;
  });
}

function squash(t) {
  return t.replace(/\b(\w+(?: \w+)?) \1\b/g, '$1').replace(/\bby (?=\w+ by\b)/g, '').replace(/\s+/g, ' ').trim();
}

function strip(t) {
  let s = t.replace(WAKE, '').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(LEAD, '').trim();
    for (const re of ASK) s = s.replace(re, '').trim();
    if (s === before) break;
  }
  s = s.replace(TRAIL, '').trim();
  return s;
}

function synonyms(t) {
  let s = t.replace(APP_WORD, '$1').replace(/\bcurrent (?=(?:media|music|song|track|video|audio|playback)\b)/g, '');
  for (const [re, to] of SYN) s = s.replace(re, to);
  // "decrease the volume" / "lower it" / "crank the music" → the "turn ..." phrasing
  s = s.replace(/^(?:reduce|lower|decrease|drop|dial down|tone down|bring down|take down|knock down|cut) (?:the )?(volume|music|sound|audio|it|this|that|song)\b ?(.*)$/, (m, what, rest) =>
    /^(?:it|this|that|song)$/.test(what) ? `turn ${what === 'song' ? 'it' : what} down ${rest}`.trim() : `turn down the ${what} ${rest}`.trim());
  s = s.replace(/^(?:increase|raise|boost|bump|crank|pump|up|put up|bring up|take up|jack up) (?:the )?(volume|music|sound|audio|it|this|that|song)\b ?(?:up\b ?)?(.*)$/, (m, what, rest) =>
    /^(?:it|this|that|song)$/.test(what) ? `turn ${what === 'song' ? 'it' : what} up ${rest}`.trim() : `turn up the ${what} ${rest}`.trim());
  // "turn the song down", "turn the music down by 10" → "turn it down ..."
  s = s.replace(/^turn (?:the )?(?:song|music|sound|audio|volume|chrome|spotify|it) (?:by )?(up|down)\b/, 'turn it $1');
  s = s.replace(/^turn (?:a|an|the) (?=\w)/, 'turn ');
  // "turn up/down to 20 percent" and "turn it to 20" → "set volume to 20"
  s = s.replace(/^(?:turn|set|put|bring|take)(?: it| the volume| volume| (chrome|spotify|edge|firefox|brave|opera|youtube|vlc|tidal))?(?: (?:up|down))? (?:to|at) (\d{1,3})(?: ?%| percent| per cent)?$/, (m, app, n) => `set volume to ${n}${app ? ' ' + app : ''}`);
  s = s.replace(/^(?:turn|set|put) (?:it |the volume |volume )?(?:to |at )?(?:max|maximum|full|100)$/, 'max volume');
  s = s.replace(/^(?:turn|set|put) (?:it |the volume |volume )?(?:to |at )?(?:min|minimum|zero|nothing)$/, 'mute');
  s = s.replace(/^un ?shuffle(?: it| this)?$/, 'shuffle off');
  s = s.replace(/\b(this|that|next|previous|last) on\b$/, '$1 one');
  return s.replace(/\s+/g, ' ').trim();
}

// indirect asks: what they say is a complaint or a wish, what they mean is one control.
// `loose` ones also fit idle talk ("hold on"), so the media skill only acts on them while something plays.
const IND = [
  { to: 'skip', re: /^(?:this|that|the) (?:song|track|one|video|music|tune|jam)(?: (?:is|was|just|really|so))* ?(?:sucks?|stinks?|bad|boring|trash|garbage|terrible|awful|mid|annoying|lame|old|overplayed|getting old|not (?:good|it|great)|not my (?:thing|vibe|style)|the worst|ass|dead)$/ },
  { to: 'skip', re: /^(?:i(?:'?m| am)?|we(?:'?re| are)?) (?:hate|can'?t stand|don'?t (?:like|want)|(?:so |really |getting |kinda )?(?:sick|tired|bored)|had enough|done|over)(?: of| with)?(?: (?:this|it|that)(?: (?:song|track|one|tune))?)?$/ },
  { to: 'skip', re: /^(?:i(?:'?m| am) )?(?:not|ain'?t) (?:feeling|vibing with|into) (?:this|it|that)(?: (?:song|track|one))?$/ },
  { to: 'skip', re: /^(?:something|anything|someone|play something|play anything|put on something|give me something|how about something) (?:else|different|new|other than this)$/ },
  { to: 'skip', re: /^(?:another|a different|different|a new|some other|an other) (?:one|song|track|tune|video)(?: please)?$/ },
  { to: 'skip', re: /^(?:change|switch|swap|flip) (?:the |this |that )?(?:song|track|tune|music|one|video)$/ },
  { to: 'skip', re: /^(?:move on|on to the next(?: one| song| track)?|next up|next one please|go next|next one|next song please|let'?s (?:go )?(?:to )?(?:the )?next(?: one| song)?|done with (?:this|it|that)(?: (?:song|track|one))?|enough of (?:this|that|it)|that'?s enough of (?:this|that|it))$/ },
  { to: 'turn it up', re: /^(?:i|we) (?:can'?t|cannot|can barely|barely|hardly|can hardly|(?:am|'m) (?:barely|hardly|struggling to)|have (?:trouble|a hard time) (?:to )?) ?hear(?: (?:it|this|that|anything|the (?:music|song|audio|sound)|you|a thing))?(?: (?:at all|over (?:the )?(?:noise|fan|fans)))?$/ },
  { to: 'turn it up', re: /^(?:it|its|it'?s|this|that|that'?s|this is|the (?:music|song|volume|sound|audio)(?: is)?|volume|music|sound|audio)(?: (?:is|was|sounds|seems|'s))*(?: a (?:bit|little|tad))?(?: (?:too|so|way too|really|a bit too|kinda|pretty|very|rather))? ?(?:quiet|low|soft|faint|silent|muffled|tiny|small)$/ },
  { to: 'turn it up', re: /^(?:it|its|it'?s|this|that|that'?s)(?: is)? ?(?:not|isn'?t) (?:loud|high) enough$/ },
  { to: 'turn it up', re: /^(?:more|a little more|a bit more|some more|give me more|need more) (?:volume|sound|noise|juice|bass)$/ },
  { to: 'turn it up', re: /^(?:hard|difficult|impossible|tough) to hear$/ },
  { to: 'turn it down', re: /^(?:it|its|it'?s|this|that|that'?s|this is|the (?:music|song|volume|sound|audio)(?: is)?|volume|music|sound|audio)(?: (?:is|was|sounds|seems|'s))*(?: a (?:bit|little|tad))?(?: (?:too|so|way too|really|a bit too|kinda|pretty|very|rather|much too))? ?(?:loud|high|blasting|blaring|deafening|booming|overwhelming|too much)$/ },
  { to: 'turn it down', re: /^(?:it|its|it'?s|this|that|that'?s)(?: is)? ?(?:hurting|hurts|killing|blowing out|damaging|bothering|giving me a headache in) my (?:ears|head|eardrums)$/ },
  { to: 'turn it down', re: /^(?:too|so|way too|much too|a bit too) loud$/ },
  { to: 'turn it down', re: /^(?:less|a little less|a bit less|too much) (?:volume|sound|noise|bass)$/ },
  { to: 'turn it down', re: /^(?:keep it down|not so loud|not that loud|tone it down|quiet(?:er)? please|a bit quiet(?:er)?|shh+ (?:a bit|a little))$/ },
  { to: 'previous', re: /^(?:play |go to |put on |back to |take me back to )?(?:the )?(?:one before|song before|track before|previous one|one i (?:had|was) (?:on|listening to)|last one|last song|song (?:from )?before (?:this|that)(?: one)?|one before this(?: one)?)$/ },
  { to: 'restart', re: /^(?:(?:play|run|put|do) (?:it|that|this|the song)(?: (?:back|again|over|one more time))|(?:one|once) more(?: time)?|again|encore|do it again|play (?:that|it|this) (?:one )?again|replay (?:that|it|this)|that was (?:good|great|fire)(?: play it again)?|(?:run|play|take) it back|from the top(?: again)?)$/ },
  { to: 'pause', re: /^(?:(?:hold on|hold up|hang on|wait|just|one|give me a|gimme a)(?: (?:a|one))? (?:sec|second|moment|minute|min)|hold on|hold up|hang on|wait|shh+|shush|hush|quiet|silence|be quiet(?: for a (?:sec|second|moment|bit))?|quiet down|pause for a (?:sec|second|moment|bit))$/, loose: true },
  { to: 'mute', re: /^(?:shut (?:it|that|this|everything|the (?:music|sound|audio)) (?:up|off|down)|kill the (?:sound|audio|volume)|no sound|sound off|cut the (?:sound|audio|volume)|silence (?:it|the (?:music|sound))|turn (?:the )?sound off)$/ },
  { to: 'stop', re: /^(?:kill the music|turn (?:the )?music off|turn it off|switch it off|switch the music off|shut off the music|that'?s all(?: for the music)?|no more music|enough music|no music|stop the tunes|cut the music|end the music|i'?m done listening|done listening)$/ },
  { to: 'what is playing', re: /^(?:what'?s|what is|what was|which|whats) (?:that|this) (?:song|track|tune|jam|one|music|banger|bop)(?: (?:called|again|name|is called))?$|^(?:what'?s|what is) (?:this|that) called$|^(?:what'?s|what is) the name of (?:this|that) (?:song|track|one)$|^(?:who|what) (?:is|was) (?:this|that) (?:song|track|one)?$|^(?:what'?s|what is) (?:this|that) (?:playing|on)$|^which song is (?:this|that|it)$|^what (?:am i|are we) (?:listening|hearing)(?: to)?$|^(?:name|title) (?:of )?(?:this|that) (?:song|track|one)$/ },
  { to: 'who is this', re: /^(?:who(?:'?s| is| was) (?:this|that) (?:by|artist|guy|girl|band|singer|group|rapper)|who (?:made|sings|sang|did|wrote|performs|performed) (?:this|that)(?: (?:song|track|one))?|whose song is (?:this|that|it)|whose (?:this|that)|who is this (?:by|from))$/ },
];

function paraphrase(t) {
  for (const r of IND) if (r.re.test(t)) return r;
  return null;
}

// one edit (insert, delete, substitute or swap) apart
function near(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;                       // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);   // swap
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// a misheard command word → the word meant. Curated list first; long vocabulary by edit distance 1 (a short word one edit
// away is usually a different word, so those are only repaired through the curated list)
function repair(t) {
  const words = t.split(' ');
  if (words.length > 9) return t;
  const out = words.map(w => {
    if (HEARD[w]) return HEARD[w];
    if (w.length >= 5) { const hit = LONG_VOCAB.filter(v => v !== w && near(w, v)); if (hit.length === 1) return hit[0]; }
    return w;
  });
  return out.join(' ');
}

function variants(cleaned) {
  const out = [];
  const seen = new Set([cleaned]);
  const push = (text, how, extra = {}) => { text = String(text || '').trim(); if (text && !seen.has(text)) { seen.add(text); out.push({ text, how, ...extra }); } };
  if (!cleaned || cleaned.split(' ').length > 22) return out;

  const base = squash(strip(cleaned));
  const norm = synonyms(digits(base));
  push(norm, 'normalized');
  // a fixed phrase first, then the word repairs, then both: "this songs sucks" → repair + paraphrase
  const asks = (s, how) => { const p = paraphrase(s); if (p) push(p.to, how, p.loose ? { loose: true } : {}); };
  asks(base, 'paraphrase'); asks(norm, 'paraphrase');
  const fixed = synonyms(digits(squash(strip(repair(cleaned)))));
  push(fixed, 'repaired');
  asks(fixed, 'repaired');
  return out;
}

module.exports = { variants, strip, synonyms, repair, paraphrase, near, wordNumber, digits, squash };
