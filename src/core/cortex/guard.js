// Cortex guard: what may be written and what may reach FTS MATCH (core spec §5, §8).

class CortexError extends Error {
  constructor(code, message) { super(message || code); this.name = 'CortexError'; this.code = code; }
}

// Never keep secrets: passwords, keys, card-like numbers. Same pattern as src/core/memory/store.js (wave 1 removes that copy).
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

// User text → a MATCH expression of quoted words joined by OR; operators never pass through. null = nothing to search.
function ftsQuery(text) {
  const seen = new Set();
  for (const w of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2 || seen.has(w)) continue;
    seen.add(w);
    if (seen.size === 12) break;
  }
  return seen.size ? [...seen].map(w => `"${w}"`).join(' OR ') : null;
}

const CORRECTION = /^\s*(?:no\b|wrong\b|that[’']?s not\b|stop saying\b)/i;
const isCorrection = text => CORRECTION.test(String(text ?? ''));

module.exports = { CortexError, SECRET, CAPS, NODE_KINDS, EVENT_KINDS, SOURCE_KINDS, MIN_TEXT, MAX_DATA, MAX_QUOTE, checkText, checkData, ftsQuery, isCorrection };
