// Text for the voice: turn a chat reply into plain speakable sentences, and cut a
// token stream into sentences as they complete (so speech starts before the reply ends).
const { delatex } = require('../../ui/markdown');

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
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Words a voice says well: times, dates, money, ranges, abbreviations, acronyms, and pauses
// from punctuation (Piper has no SSML; both engines pause on commas and full stops).
function articulate(s) {
  s = s.replace(/\bJ\.A\.R\.V\.I\.S\.?|\bJARVIS\b/g, 'Jarvis');
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${MONTHS[+mo - 1]} ${+d}, ${y}` : m));
  // clock times: "3:05 PM" → "3 oh 5 P M", "3:00 pm" → "3 P M", "15:00" → "15 hundred", "9:00" → "9 o'clock"
  s = s.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([AaPp])\.?\s?[Mm](?![a-z])(?:\.(?=\s+[a-z]))?)?/g, (m, h, mm, ap) => {
    const ampm = ap ? ` ${ap.toUpperCase()} M` : '';
    if (mm === '00') return ap ? `${+h}${ampm}` : +h > 12 ? `${+h} hundred` : `${+h} o'clock`;
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

function speakable(text) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' I put the code in the chat. ');
  s = s.split('\n').map(l => delatex(l)).join('\n');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/https?:\/\/\S+/g, 'the link');
  s = s.replace(/\(([^()]*)\)\s*\/\s*\(([^()]*)\)/g, '$1 over $2');            // (hc)/(λ) from LaTeX fractions
  s = s.replace(/^\s*#{1,6}\s*(.+)$/gm, '$1.').replace(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/gm, '$1.').replace(/^\s*>\s?/gm, '');
  s = s.replace(/\*\*|__|\*|_(?=\w)|(?<=\w)_/g, '');
  s = s.replace(/(\d)\s*×\s*10([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)/g, (m, d, e) => `${d} times 10 to the ${[...e].map(c => SUPER[c]).join('').replace('minus ', 'minus ')}`);
  s = s.replace(/([A-Za-z0-9)])²/g, '$1 squared').replace(/([A-Za-z0-9)])³/g, '$1 cubed');
  s = articulate(s);
  for (const [re, w] of UNITS) s = s.replace(re, w);
  for (const [re, w] of SYMBOLS) s = s.replace(re, w);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, m => ' to the ' + [...m].map(c => SUPER[c]).join(''));
  s = s.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').trim();
  return s;
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

module.exports = { speakable, articulate, createSentenceSplitter };
