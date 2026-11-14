'use strict';
// Execution ledger: what this session's tools already did, across turns. It stops a repeated write ("send it again" heard
// twice, a retry after a timeout) from acting twice, and lets a repeated read reuse its result. exec() asks it, never the model.
// Reads are valid only until the next successful write/external in the same session (the epoch), because a write may have
// changed what the read would see. A write that timed out is 'unknown': it may have happened, so a non-idempotent repeat is refused.

const TEXT_CAP = 2000;

// force is the runner's flag, never a call argument: dropped from the key so a model-sent force cannot make a distinct call
function stable(v) {
  if (typeof v === 'string') return JSON.stringify(v.trim().toLowerCase());
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => k !== 'force' && v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

function createLedger({ ttlMs = 60000, now = Date.now, maxPerSession = 100, maxSessions = 64 } = {}) {
  const sessions = new Map();   // id -> { epoch, entries: Map(key -> entry) }; Map order = age, oldest first
  let seq = 0;
  const key = (name, args) => name + '|' + stable(args ?? {});

  function check(sid, name, args, { effect = 'write', idempotent = false, volatile = false, turnId, force = false } = {}) {
    const s = sessions.get(sid);
    const k = key(name, args);
    const e = s?.entries.get(k);
    if (!e) return null;
    const ageMs = now() - e.at;
    if (ageMs > ttlMs) { s.entries.delete(k); return null; }
    // a forced repeat runs once per turn: this turn's own entry still answers the second one
    if (force && e.turnId !== turnId) return null;
    const out = { text: e.text, ok: e.ok, untrusted: e.untrusted, ageMs, resultRef: e.ref };
    if (effect === 'read') {
      if (e.epoch !== s.epoch || (volatile && e.turnId !== turnId)) return null;
      return { hit: 'cached', ...out };
    }
    if (e.unknown) return idempotent ? null : { hit: 'unknown', ...out };
    return { hit: 'done', ...out };
  }

  function record(sid, name, args, { effect = 'write', ok = true, text = '', untrusted = false, unknown = false, turnId } = {}) {
    let s = sessions.get(sid);
    if (!s) {
      s = { epoch: 0, entries: new Map() };
      sessions.set(sid, s);
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    }
    if (effect !== 'read') s.epoch++;
    const ref = 'l' + (++seq);
    const k = key(name, args);
    s.entries.delete(k);   // re-insert so the Map order stays oldest-first
    s.entries.set(k, { at: now(), epoch: s.epoch, ok, unknown, untrusted: !!untrusted, turnId, ref, text: String(text).slice(0, TEXT_CAP) });
    if (s.entries.size > maxPerSession) s.entries.delete(s.entries.keys().next().value);
    return ref;
  }

  const forget = sid => { sessions.delete(sid); };
  return { key, check, record, forget };
}

module.exports = { createLedger };
