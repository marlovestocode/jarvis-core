// Cortex guard: what may be written and what may reach FTS MATCH (core spec §5, §8).

class CortexError extends Error {
  constructor(code, message) { super(message || code); this.name = 'CortexError'; this.code = code; }
}

// Never keep secrets: passwords, keys, card-like numbers. The one copy (the old memory store's was removed in wave 1).
const SECRET = /\b(?:password|passcode|passphrase|pin\s*(?:code|number)?|api[\s_-]?key|secret|token|cvv|ssn|social security)\b|\b(?:\d[ -]?){13,19}\b/i;

// Per-kind text caps (plan D10). The keys are the closed set of node kinds (plan D9).
const CAPS = { fact: 300, entity: 120, chat: 1200, knowledge: 2000, reminder: 200, track: 300, artist: 300, playlist: 300, file: 600, folder: 600 };
const NODE_KINDS = new Set(Object.keys(CAPS));
const EVENT_KINDS = new Set(['play', 'action', 'playlist_edit', 'tool', 'reminder_fired', 'lookup']);
const SOURCE_KINDS = new Set(['user', 'tool', 'import', 'wiki', 'web', 'model']);
const MIN_TEXT = 3;
const MAX_DATA = 4096;
const MAX_QUOTE = 240;

function checkText(kind, text) {
  if (!NODE_KINDS.has(kind)) throw new CortexError('kind', 'unknown node kind: ' + kind);
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < MIN_TEXT) throw new CortexError('too_short');
  if (t.length > CAPS[kind]) throw new CortexError('too_long');
  if (SECRET.test(t)) throw new CortexError('secret');
  return t;
}

// data → JSON string (or null); objects only, ≤ 4 KB, no secrets
function checkData(data) {
  if (data === undefined || data === null) return null;
  if (typeof data !== 'object' || Array.isArray(data)) throw new CortexError('data');
  const s = JSON.stringify(data);
  if (Buffer.byteLength(s) > MAX_DATA) throw new CortexError('data_too_big');
  if (SECRET.test(s)) throw new CortexError('secret');
  return s;
}

// English function words: they match most of the store and carry no topic, so they never reach MATCH.
const STOPWORDS = new Set(('the of and to in is it you that he was for on are with as his they at be this have from or one had by but not what all were we when ' +
  'your can said there an each which she do how their if will up about out many then them so some her would my me has him its our us i am been ' +
  'did does who whom whose why where these those than too very just also into over again any no nor only own same such both few more most other ' +
  'off once here should could may might must shall let get got please tell know').split(' '));

// User text → the search words: lowercased, letters/digits only, no stopwords, no one-letter tokens, at most 12, once each
function ftsTokens(text) {
  const seen = new Set();
  for (const w of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    if (seen.size === 12) break;
  }
  return [...seen];
}

// Tokens → a MATCH expression of quoted words joined by OR; operators never pass through. null = nothing to search.
const ftsOr = tokens => (tokens.length ? tokens.map(w => `"${w}"`).join(' OR ') : null);
const ftsQuery = text => ftsOr(ftsTokens(text));

const CORRECTION = /^\s*(?:no\b|wrong\b|that[’']?s not\b|stop saying\b)/i;
const isCorrection = text => CORRECTION.test(String(text ?? ''));

module.exports = { CortexError, SECRET, CAPS, NODE_KINDS, EVENT_KINDS, SOURCE_KINDS, MIN_TEXT, MAX_DATA, MAX_QUOTE, checkText, checkData, ftsQuery, ftsTokens, ftsOr, STOPWORDS, isCorrection };
