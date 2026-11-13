// Requests the code can answer exactly, with no model call: the time, the date, and plain arithmetic.
//   instant(text, { now, locale }) -> null | { reply, tool, ok: true }
// Whole-message matches only: anything with more in it ("what time does the game start", "5 plus the speed of light") goes
// to the model. The answer comes from the clock and the expression evaluator, so it cannot be wrong the way a model's can.
const { evaluate } = require('./expr');
const { units, days } = require('./instant-more');

const HEAD = /^(?:(?:please|hey|ok|okay)[,\s]+|jarvis[,\s]+)*/i;
const TIME = /^(?:what(?:'s|’s| is)? (?:the )?(?:current )?time(?: is it)?(?: right)?(?: now)?|what time is it(?: right)?(?: now)?|(?:tell me|give me) the time|(?:do you know|do you have) the time|time)$/i;
const DATE = /^(?:what(?:'s|’s| is)? (?:today(?:'s|’s)? date|the date(?: today)?|the day(?: today)?|the date and time)|what (?:day|date) is it(?: today)?|what day of the week is it(?: today)?|today(?:'s|’s)? date)$/i;
const CALC_HEAD = /^(?:what(?:'s|’s| is)|calculate|compute|calc|how much is|work out|evaluate)\s+(?:the\s+)?/i;

const WORDS = [
  [/\bto the power of\b/g, '^'], [/\bsquared\b/g, '^2'], [/\bcubed\b/g, '^3'],
  [/\bsquare root of\s+(\d+(?:\.\d+)?)/g, 'sqrt($1)'],
  [/\bmultiplied by\b|\btimes\b|(?<=\d)\s*[x×]\s*(?=\d)/g, '*'],
  [/\bdivided by\b|\bover\b|÷/g, '/'],
  [/\bplus\b/g, '+'], [/\bminus\b/g, '-'],
  [/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/g, '($1/100*$2)'],
];

function clock(now, locale) {
  return now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

function arithmetic(raw) {
  if (!CALC_HEAD.test(raw)) return null;
  let e = raw.replace(CALC_HEAD, '').replace(/[?!.\s]+$/, '').toLowerCase();
  if (/\d{4}-\d{1,2}-\d{1,2}|\d+\/\d+\/\d+/.test(e)) return null;   // a date, not a sum
  e = e.replace(/(\d),(?=\d{3}\b)/g, '$1');
  for (const [re, to] of WORDS) e = e.replace(re, to);
  if (!/^[\d\s.+\-*/^()%]*(?:sqrt\(\d+(?:\.\d+)?\))?[\d\s.+\-*/^()%]*$/.test(e)) return null;   // any leftover word means it is not plain arithmetic
  if (!/\d/.test(e) || !/[+\-*/^]|sqrt/.test(e) || /%/.test(e)) return null;
  let r;
  try { r = evaluate(e); } catch { return null; }
  if (!r || typeof r.text !== 'string' || r.text.length > 40) return null;
  return `${raw.replace(CALC_HEAD, '').replace(/[?!.\s]+$/, '')} = ${r.text}.`;
}

function instant(text, { now = new Date(), locale } = {}) {
  const raw = String(text || '').trim().replace(HEAD, '').trim();
  if (!raw || raw.length > 80) return null;
  const t = raw.replace(/[?!.\s]+$/, '');
  if (TIME.test(t)) return { reply: `It's ${clock(now, locale)}.`, tool: 'clock', ok: true };
  if (DATE.test(t)) return { reply: `It's ${now.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`, tool: 'clock', ok: true };
  const sum = arithmetic(raw);
  if (sum) return { reply: sum, tool: 'calculator', ok: true };
  const dy = days(t, now, locale);
  if (dy) return { reply: dy, tool: 'clock', ok: true };
  const un = units(raw);
  if (un) return { reply: un, tool: 'calculator', ok: true };
  return null;
}

module.exports = { instant };
