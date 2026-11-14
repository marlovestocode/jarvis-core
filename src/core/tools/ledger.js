'use strict';
// Execution ledger: what this session's tools already did, across turns. It stops a repeated write ("send it again" heard
// twice, a retry after a timeout) from acting twice, and lets a repeated read reuse its result. exec() asks it, never the model.
// Reads are valid only until the next successful write/external in the same session (the epoch), because a write may have
// changed what the read would see. A write that timed out is 'unknown': it may have happened, so a non-idempotent repeat is refused.
const { toolContract } = require('../skills/toolcards');
const { softFail, NEEDS_OK } = require('../brain/guard');

const TEXT_CAP = 2000;

// Strings are trimmed; they are lower-cased only for reads ("Paris" and "paris" ask the same question), never for writes
// (a message, a path or an id that differs in case is a different action). force is the runner's flag, never a call argument:
// dropped at the top level only, so a model-sent force cannot make a distinct call but a nested or real param named force still counts.
function stable(v, fold, top) {
  if (typeof v === 'string') return JSON.stringify(fold ? v.trim().toLowerCase() : v.trim());
  if (Array.isArray(v)) return '[' + v.map(x => stable(x, fold)).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => !(top && k === 'force') && v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k], fold)).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

function createLedger({ ttlMs = 60000, now = Date.now, maxPerSession = 100, maxSessions = 64 } = {}) {
  const sessions = new Map();   // id -> { epoch, entries: Map(key -> entry) }; Map order = age, oldest first
  let seq = 0;
  const key = (name, args, effect = 'write') => name + '|' + stable(args ?? {}, effect === 'read', true);

  function check(sid, name, args, { effect = 'write', idempotent = false, volatile = false, turnId, force = false } = {}) {
    const s = sessions.get(sid);
    const k = key(name, args, effect);
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
    const k = key(name, args, effect);
    s.entries.delete(k);   // re-insert so the Map order stays oldest-first
    s.entries.set(k, { at: now(), epoch: s.epoch, ok, unknown, untrusted: !!untrusted, turnId, ref, text: String(text).slice(0, TEXT_CAP) });
    if (s.entries.size > maxPerSession) s.entries.delete(s.entries.keys().next().value);
    return ref;
  }

  const forget = sid => { sessions.delete(sid); };
  return { key, check, record, forget };
}

// exec() hooks, so the registry stays lean. Owner turns only: a guest is never served from, or recorded in, the owner's ledger.
// ctx.force/fresh/turnId/sessionId come from the orchestrator; the model's args.force is never read.
function ledgerGate(tool, name, args, ctx) {
  const led = ctx.ledger && ctx.sessionId && !ctx.turn?.speaker ? ctx.ledger : null;
  if (!led) return { led: null };
  const c = toolContract(tool);
  const g = { led, c };
  if (ctx.fresh === true) return g;
  const hit = led.check(ctx.sessionId, name, args, { effect: c.effect, idempotent: c.idempotent, volatile: c.volatile, turnId: ctx.turnId, force: ctx.force === true });
  if (hit?.hit === 'unknown') g.res = { ok: false, text: `Error: the earlier ${name} did not report back, so I did not repeat it. Ask the user whether to try again.`, ledger: 'unknown', skipped: true };
  else if (hit) {
    // a cached read returns its own text (soft-fail checks still read it); only a repeated action says it was already done
    const text = hit.hit === 'cached' ? hit.text : `Already done (${Math.round(hit.ageMs / 1000)}s ago): ${hit.text}`;
    g.res = { ok: true, text, ledger: hit.hit, skipped: true, ...(hit.untrusted && { untrusted: true }) };
  }
  return g;
}

// Only a real success is remembered: a confirm proposal is a question, and a soft failure ("Could not find...") did nothing,
// so a retry must run again.
function ledgerRecord(g, ctx, name, args, text, untrusted) {
  if (!g.led || text.startsWith(NEEDS_OK) || softFail(text) || /^error/i.test(text)) return;
  g.led.record(ctx.sessionId, name, args, { effect: g.c.effect, ok: true, text, untrusted, turnId: ctx.turnId });
}

// a write that timed out may still have happened: remember it as unknown
function ledgerTimeout(g, ctx, name, args, err) {
  if (g.led && err?.timedOut && g.c.effect !== 'read') g.led.record(ctx.sessionId, name, args, { effect: g.c.effect, ok: false, unknown: true, text: String(err.message), turnId: ctx.turnId });
}

module.exports = { createLedger, ledgerGate, ledgerRecord, ledgerTimeout };
