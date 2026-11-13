// Text for the voice: turn a chat reply into plain speakable sentences, and cut a
// token stream into sentences as they complete (so speech starts before the reply ends).
const { delatex } = require('../../ui/markdown');
const { resolve: resolveDialect } = require('./dialect');
const DEFAULT_DIALECT = resolveDialect({});

const UNITS = [
  [/\bkm\/s\b/g, 'kilometers per second'], [/\bm\/s²|\bm\/s\^2\b/g, 'meters per second squared'], [/\bm\/s\b/g, 'meters per second'],
  [/\bkm\/h\b/g, 'kilometers per hour'], [/\bmph\b/g, 'miles per hour'], [/\bkWh\b/g, 'kilowatt hours'], [/\bMHz\b/g, 'megahertz'],
  [/\bGHz\b/g, 'gigahertz'], [/\bHz\b/g, 'hertz'], [/\bkeV\b/g, 'kilo electron volts'], [/\bMeV\b/g, 'mega electron volts'], [/\beV\b/g, 'electron volts'],
  [/\bGB\b/g, 'gigabytes'], [/\bMB\b/g, 'megabytes'], [/\bnm\b/g, 'nanometers'], [/\bkg\b/g, 'kilograms'], [/\bkm\b/g, 'kilometers'],
  [/°C\b/g, ' degrees Celsius'], [/°F\b/g, ' degrees Fahrenheit'], [/°/g, ' degrees'], [/(\d)\s*%/g, '$1 percent'],
];
const SUPER = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': 'minus ' };
const SYMBOLS = [[/√\s*\(?/g, 'square root of '], [/≈/g, ' approximately '], [/×/g, ' times '], [/÷/g, ' divided by '], [/±/g, ' plus or minus '],
  [/≤/g, ' less than or equal to '], [/≥/g, ' greater than or equal to '], [/≠/g, ' not equal to '], [/π/g, 'pi'], [/∞/g, 'infinity'],
  [/→/g, ' to '], [/λ/g, 'lambda'], [/Δ/g, 'delta '], [/μ/g, 'micro'], [/·/g, ' times '], [/\s=\s/g, ' equals '], [/\s\+\s/g, ' plus '], [/\s−\s|\s-\s(?=\d)/g, ' minus ']];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ACRONYMS = { GPU: 'G P U', CPU: 'C P U', VRAM: 'V RAM', PC: 'P C', OS: 'O S', API: 'A P I', URL: 'U R L', USB: 'U S B', SSD: 'S S D', HDD: 'H D D',
  AI: 'A I', TTS: 'T T S', STT: 'S T T', FPS: 'F P S', NFL: 'N F L', NBA: 'N B A', MLB: 'M L B', NHL: 'N H L', UK: 'U K', USA: 'U S A', EU: 'E U' };
const SPOKEN_UNITS = [[/(\d)\s*ms\b/g, '$1 milliseconds'], [/(\d)\s*Mbps\b/g, '$1 megabits per second'], [/(\d)\s*Gbps\b/g, '$1 gigabits per second'],
  [/(\d)\s*TB\b/g, '$1 terabytes'], [/(\d)\s*KB\b/g, '$1 kilobytes'], [/(\d)\s*kW\b/g, '$1 kilowatts'], [/(\d)\s*W\b/g, '$1 watts'],
  [/(\d)\s*cm\b/g, '$1 centimeters'], [/(\d)\s*mm\b/g, '$1 millimeters'], [/(\d)\s*m\b(?![/²^])/g, '$1 meters'], [/(\d)\s*ft\b/g, '$1 feet'],
  [/(\d)\s*lbs?\b/g, '$1 pounds'], [/(\d)\s*oz\b/g, '$1 ounces'], [/(\d)\s*mi\b/g, '$1 miles'], [/(\d)\s*(?:hrs?|h)\b/g, '$1 hours'],
  [/(\d)\s*mins?\b/g, '$1 minutes'], [/(\d)\s*(?:secs?|s)\b/g, '$1 seconds'], [/(\d)\s*fps\b/gi, '$1 frames per second']];
// "2026" is "twenty twenty-six", not "two thousand twenty-six"; only where it is plainly a year (after a month or a
// date, or after in/since/from/until/by/during/of/before/after, or in "(1999)"), so "2026 files" and "1500 meters" are left alone.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const below100 = n => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''));
function yearWords(y) {
  const hi = Math.floor(y / 100), lo = y % 100;
  if (y >= 2000 && y <= 2009) return y === 2000 ? 'two thousand' : `two thousand and ${ONES[lo]}`;
  if (lo === 0) return `${below100(hi)} hundred`;
  return `${below100(hi)} ${lo < 10 ? 'oh ' + ONES[lo] : below100(lo)}`;
}
// Whole numbers as words, for the ones a voice reads badly with their commas ("1,234,567") and for ordinals ("3rd", "21st").
const SCALES = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
function intWords(n, and = false) {
  if (n < 20) return ONES[n];
  if (n < 100) return below100(n);
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return `${ONES[h]} hundred${r ? (and ? ' and ' : ' ') + below100(r) : ''}`; }
  for (const [size, name] of SCALES) {
    if (n >= size) { const head = Math.floor(n / size), r = n % size; return `${intWords(head, and)} ${name}${r ? (r < 100 && and ? ' and ' : ' ') + intWords(r, and) : ''}`; }
  }
  return String(n);
}
const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
function ordinalWords(n) {
  const w = intWords(n);
  const cut = w.search(/[a-z]+$/);
  const last = w.slice(cut);
  const ord = ORD[last] || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th');
  return w.slice(0, cut) + ord;
}
const MONTH_RE = MONTHS.join('|');
const YEAR_CTX = new RegExp(String.raw`(\b(?:${MONTH_RE})\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?|\b(?:in|since|from|until|till|by|during|of|before|after|circa|early|late|mid)\s+|\()(1[1-9]\d\d|20\d\d)(?![\d,.]*\d|\s*(?:%|(?:meters?|metres?|kilometers?|km|cm|mm|ms|seconds?|minutes?|hours?|days?|miles?|feet|ft|kg|grams?|pounds?|lbs?|dollars?|euros?|people|files?|items?|users?|points?|words?|bytes?|mb|gb|kb|hz|mhz|ghz|rpm|watts?|degrees?|m|g|w)\b))`, 'gi');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Words a voice says well: times, dates, money, ranges, abbreviations, acronyms, and pauses
// from punctuation (Piper has no SSML; both engines pause on commas and full stops).
function articulate(s, d = DEFAULT_DIALECT) {
  s = s.replace(/\bJ\.A\.R\.V\.I\.S\.?|\bJARVIS\b/g, 'Jarvis');
  // a number glued to its unit ("5km", "2.5GB", "30ms") is split so the unit rules below see it
  s = s.replace(/(\d)(?=(?:km\/h|km|kg|cm|mm|ms|mb|gb|tb|kb|mph|ghz|mhz|khz|hz|kw|ft|lbs?|oz|mi|mins?|secs?|hrs?|fps|mbps|gbps)\b)/gi, '$1 ');
  // dates: "2026-11-12" → "12 November 2026" (British order) or "November 12, 2026"
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, dd) => (+mo >= 1 && +mo <= 12 && +dd >= 1 && +dd <= 31 ? (d.dateOrder === 'dmy' ? `${+dd} ${MONTHS[+mo - 1]} ${y}` : `${MONTHS[+mo - 1]} ${+dd}, ${y}`) : m));
  // ordinals: "3rd" → "third", "21st" → "twenty-first"
  s = s.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, (m, n) => ordinalWords(+n));
  s = s.replace(YEAR_CTX, (m, pre, y) => pre + yearWords(+y));
  // clock times: "3:05 PM" → "3 oh 5 P M", "3:00 pm" → "3 P M", "15:00" → "15 hundred", "9:00" → "9 o'clock"
  s = s.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([AaPp])\.?\s?[Mm](?![a-z])(?:\.(?=\s+[a-z]))?)?/g, (m, h, mm, ap) => {
    const ampm = ap ? ` ${ap.toUpperCase()} M` : '';
    if (!ap && +h > 12) return mm === '00' ? `${intWords(+h)} hundred` : `${intWords(+h)} ${mm[0] === '0' ? 'oh ' + ONES[+mm[1]] : intWords(+mm)}`;   // 24-hour: "fourteen thirty", "fifteen hundred"
    if (mm === '00') return ap ? `${+h}${ampm}` : `${+h} o'clock`;
    return `${+h} ${mm[0] === '0' ? 'oh ' + mm[1] : mm}${ampm}`;
  });
  s = s.replace(/\b(\d{1,2})\s*([AaPp])\.?[Mm](?![a-z])(?:\.(?=\s+[a-z]))?/g, (m, h, ap) => `${h} ${ap.toUpperCase()} M`);
  // money: "$5.99" → "5 dollars 99 cents", "$1.5 million" → "1.5 million dollars"
  s = s.replace(/\$(\d[\d,]*)(?:\.(\d+))?(\s*(?:thousand|million|billion|trillion))?\b/g, (m, d, c, big) => {
    if (big || (c && c.length !== 2)) return `${d}${c ? '.' + c : ''}${big || ''} dollars`;
    const n = Number(d.replace(/,/g, ''));
    return `${d} dollar${n === 1 ? '' : 's'}` + (c && +c ? ` ${plural(+c, 'cent')}` : '');
  });
  s = s.replace(/€(\d[\d,.]*)/g, '$1 euros').replace(/£(\d[\d,.]*)/g, '$1 pounds');
  // "1,234,567" → words (a voice reads the commas as pauses). Decimals ("1,234.5") and codes like "12,34" are left alone.
  s = s.replace(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,]|\.\d)/g, m => { const n = Number(m.replace(/,/g, '')); return n < 1e12 ? intWords(n, d.numberAnd) : m; });
  // ranges "10-20" / "10–20" (spaced "5 - 3" stays subtraction)
  s = s.replace(/\b(\d+(?:\.\d+)?)\s?[-–]\s?(\d+(?:\.\d+)?)\b/g, (m, a, b) => (/\s-\s/.test(m) ? m : `${a} to ${b}`));
  s = s.replace(/#(\d)/g, 'number $1').replace(/\bNo\.\s?(\d)/g, 'number $1');
  s = s.replace(/\be\.g\.,?/gi, 'for example').replace(/\bi\.e\.,?/gi, 'that is').replace(/\betc\./gi, 'et cetera').replace(/\bvs\.?(?=\s)/gi, 'versus')
    .replace(/\bapprox\.\s?/gi, 'about ').replace(/\b(?:feat|ft)\.\s?(?=[A-Z])/g, 'featuring ').replace(/\bw\/\s?/g, 'with ').replace(/\s&\s/g, ' and ')
    .replace(/\band\/or\b/g, 'and or').replace(/~\s?(?=\d)/g, 'about ').replace(/\s@\s/g, ' at ').replace(/(^|\s)\+(\d)/g, '$1plus $2');
  for (const [re, w] of SPOKEN_UNITS) s = s.replace(re, w);
  s = s.replace(/\b[A-Z]{2,5}\b/g, w => ACRONYMS[w] || w);
  // pauses: dashes and semicolons split phrases; short asides in parentheses become commas
  s = s.replace(/\s*—\s*|\s–\s|\s-\s(?!\d)/g, ', ').replace(/;\s*/g, '. ').replace(/…/g, '.')
    .replace(/\s*\(([^()]{1,80})\)/g, ', $1,').replace(/,\s*([.!?])/g, '$1').replace(/,\s*,/g, ',');
  return s;
}

// ---- how a person says it ----
// Models write "I am unable to" and "Please let me know if you need anything else"; people say "I can't" and stop.
// Only forms that are never stressed are contracted; "it is" and "that is" stay, since "It is 21 degrees" is fine spoken.
const NEG = { do: "don't", does: "doesn't", did: "didn't", is: "isn't", are: "aren't", was: "wasn't", were: "weren't", has: "hasn't", have: "haven't", had: "hadn't", would: "wouldn't", could: "couldn't", should: "shouldn't", must: "mustn't", cannot: "can't", will: "won't" };
const capFirst = (src, w) => (/^[A-Z]/.test(src) ? w[0].toUpperCase() + w.slice(1) : w);
// closers and throat-clearing that add nothing when spoken
const FILLER = /(?:^|(?<=[.!?]\s))(?:I hope (?:this|that|it) helps|(?:Please )?let me know[^.!?]*|Feel free to (?:ask|reach out)[^.!?]*|Is there anything else[^.!?]*|Do you (?:need|want) (?:anything|any) (?:else|more)[^.!?]*|As an AI(?: language model)?,?[^.!?]*|I(?:'d| would) be (?:happy|glad) to help[^.!?]*|Great question)[.!?]\s*/gi;

// Said aloud, the words follow the chosen dialect (config.speech, see dialect.js): its register words, and contractions when it uses them.
function humanize(text, d = DEFAULT_DIALECT) {
  let s = String(text || '');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  s = s.replace(FILLER, '');
  for (const [re, w] of d.register) s = s.replace(re, typeof w === 'string' ? m => capFirst(m, w) : w);
  if (d.contractions) {
    s = s.replace(/\b(do|does|did|is|are|was|were|has|have|had|would|could|should|must|will) not\b/gi, (m, v) => capFirst(m, NEG[v.toLowerCase()]));
    s = s.replace(/\bcan(?:not| not)\b/gi, m => capFirst(m, "can't"));
    s = s.replace(/\bI am\b/g, "I'm").replace(/\bI will\b/g, "I'll").replace(/\bI have (?=been|got|had|not|never)/g, "I've ");
    s = s.replace(/\b(you|we|they) are\b/gi, "$1're").replace(/\b(you|we|they) will\b/gi, "$1'll").replace(/\b(you|we|they) have (?=been|got|had|never)/gi, "$1've ");
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

// "1 kilometers" → "1 kilometer": a unit rule turns "km" into the plural whatever the number was
const SINGULAR = /(?<![\d.,])1 (kilometer|meter|centimeter|millimeter|mile|kilogram|gram|pound|ounce|gigabyte|megabyte|terabyte|kilobyte|hour|minute|second|millisecond|watt|kilowatt|degree)s\b/gi;

// Piper and System.Speech pause only on punctuation. A long sentence with no comma is read in one breath, so a comma goes in
// before its first joining word ("and", "but", "which", "because"...) once it has run a while.
const NUMBER_WORD = new RegExp(`^(?:${[...ONES, ...TENS.filter(Boolean)].join('|')})\b`, 'i');
function pace(text) {
  return text.split(/(?<=[.!?])\s+/).map(sent => {
    const words = sent.split(/\s+/);
    if (words.length < 18 || (sent.match(/,/g) || []).length >= 2) return sent;
    return sent.replace(/\s+(and|but|which|because|while|although|so that)\s+/gi, (m, w, off) => {
      const before = sent.slice(0, off), after = sent.slice(off + m.length);
      const at = before.split(/\s+/).length;
      const inNumber = /(?:hundred|thousand|million|billion)$/i.test(before) || (/^and$/i.test(w) && NUMBER_WORD.test(after));   // "two hundred and five" is one number
      return at >= 7 && at <= words.length - 5 && !/,$/.test(before) && !inNumber ? `, ${w} ` : m;
    });
  }).join(' ');
}

// opts.dialect: a resolved dialect (dialect.resolve(config.speech)); the default is the British formal one
function speakable(text, { dialect = DEFAULT_DIALECT } = {}) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' I put the code in the chat. ');
  s = s.split('\n').map(l => delatex(l)).join('\n');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/https?:\/\/\S+/g, 'the link');
  s = s.replace(/\(([^()]*)\)\s*\/\s*\(([^()]*)\)/g, '$1 over $2');            // (hc)/(λ) from LaTeX fractions
  s = s.replace(/^\s*#{1,6}\s*(.+)$/gm, '$1.').replace(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/gm, '$1.').replace(/^\s*>\s?/gm, '');
  s = s.replace(/\*\*|__|\*|_(?=\w)|(?<=\w)_/g, '');
  s = s.replace(/(\d)\s*×\s*10([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)/g, (m, d, e) => `${d} times 10 to the ${[...e].map(c => SUPER[c]).join('').replace('minus ', 'minus ')}`);
  s = s.replace(/([A-Za-z0-9)])²/g, '$1 squared').replace(/([A-Za-z0-9)])³/g, '$1 cubed');
  s = articulate(s, dialect);
  for (const [re, w] of UNITS) s = s.replace(re, w);
  for (const [re, w] of SYMBOLS) s = s.replace(re, w);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, m => ' to the ' + [...m].map(c => SUPER[c]).join(''));
  s = s.replace(SINGULAR, '1 $1');
  s = s.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').trim();
  s = humanize(s, dialect);
  return dialect.pauses ? pace(s) : s;
}

const ABBREV = /\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|Inc|approx|No|St)\.$/i;

function createSentenceSplitter({ maxChars = 160 } = {}) {
  let buf = '';
  function take() {
    const out = [];
    for (;;) {
      const re = /([.!?]+)(?=\s)|\n+/g;
      let m, cut = -1;
      while ((m = re.exec(buf))) {
        const end = m.index + m[0].length;
        const head = buf.slice(0, m.index + (m[1] ? m[1].length : 0));
        if (m[1] && (/\d\.$/.test(head) && /^\d/.test(buf.slice(end).trimStart()) || ABBREV.test(head))) continue;
        cut = end; break;
      }
      if (cut < 0 && buf.length > maxChars) {
        const c = buf.lastIndexOf(', ', maxChars);
        if (c > 20) cut = c + 1;
      }
      if (cut < 0) return out;
      const sentence = buf.slice(0, cut).trim();
      buf = buf.slice(cut);
      if (sentence) out.push(sentence);
    }
  }
  return {
    push(text) { buf += String(text || ''); return take(); },
    flush() { const rest = buf.trim(); buf = ''; return rest ? [rest] : []; },
  };
}

module.exports = { speakable, articulate, humanize, createSentenceSplitter };
