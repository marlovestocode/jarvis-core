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

module.exports = { speakable, createSentenceSplitter };
