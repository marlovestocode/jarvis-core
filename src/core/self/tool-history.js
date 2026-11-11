// Tool history (W2 §2, §6, plan E14): one cortex `tool` event per tool call, { name, ok, ms, args, turn }, never the
// result. Args are cut and redacted first: at most 10 keys, each value a string of at most 200 chars, "[hidden]" when
// it looks like a secret (the cortex guard pattern, which also catches long numbers). Kept 90 days.
const { SECRET } = require('../cortex/guard');

const DAY = 864e5;
const KEEP_DAYS = 90, MAX_KEYS = 10, MAX_VALUE = 200;

function redactArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const [k, v] of Object.entries(args).slice(0, MAX_KEYS)) {
    let s;
    if (typeof v === 'string') s = v;
    else { try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); } }
    out[String(k).slice(0, 40)] = SECRET.test(s) ? '[hidden]' : s.slice(0, MAX_VALUE);
  }
  return out;
}

function createToolHistory({ cortex, now = Date.now }) {
  function record({ name, ok, ms, args, turn } = {}) {
    const payload = { name: String(name || '?').slice(0, 80), ok: !!ok, ms: Math.max(0, Math.round(Number(ms) || 0)), args: redactArgs(args) };
    if (turn) payload.turn = String(turn).slice(0, 20);
    cortex.event.add({ kind: 'tool', payload, at: now() });
  }

  const recent = ({ since = null, until = null, limit = 1e6 } = {}) => cortex.event.query({ kind: 'tool', since, until, limit }).map(e => ({ ...e.payload, at: e.at }));

  // name → { calls, fails, lastAt } over [since, now]
  function stats({ since = null } = {}) {
    const m = new Map();
    for (const e of recent({ since })) {
      const s = m.get(e.name) || { calls: 0, fails: 0, lastAt: 0 };
      s.calls++; if (!e.ok) s.fails++; s.lastAt = Math.max(s.lastAt, e.at);
      m.set(e.name, s);
    }
    return m;
  }

  const prune = () => cortex.event.deleteWhere({ kind: 'tool', before: now() - KEEP_DAYS * DAY });

  return { record, stats, recent, prune };
}

module.exports = { createToolHistory, redactArgs };
