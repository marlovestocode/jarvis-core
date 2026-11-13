'use strict';
// Discovery + gating (ADR A-002, Task 3): decides whether a turn needs the intent interpreter at all, which capability
// cards it is shown, and how its answer is merged with the rule result. Interpretation only RECOMMENDS groups:
// risk:'confirm', taint, GUEST_TOOLS and the owner checks still decide what may run.
//   gate(...)            sync: { call, why } - the cheap check that keeps simple commands model-free
//   shortlist(...)       async: card ids most related to the text (embedding + lexical, lexical only without embed)
//   resolveSelection(...) async: { action, groups, source, ask?, decline?, intent?, decision }
const { createRanker } = require('./rank');
const { selectGroups, MAX_GROUPS } = require('./select');
const { interpret, BUDGET_MS } = require('./intent');
const { buildCard, groupSideEffects } = require('./capability');
const { clarify } = require('./clarify');
const { FACT } = require('../brain/router');
const { NOT_CLAIM } = require('../brain/guard');

const SHORTLIST = 8;          // a catalog this size or smaller is shown whole
const MULTI_MAX = 3;          // groups when the interpretation names several
const ACT_MIN = 0.6;          // below this a write/external group asks instead of acting
const EMBED_MS = 250;         // the embedding is a nicety: it never eats the interpreter's budget
const RISKY = new Set(['write', 'external']);
const ASK_TEXT = 'Could you tell me a bit more about what you would like me to do?';
const QUOTED = /["“”]/;   // the request quotes someone: it may be about the words, not an order

const effectsCache = new WeakMap();
function effectsOf(catalog, id) {
  let m = effectsCache.get(catalog);
  if (!m) { m = new Map(catalog.groups.map(g => [g.id, groupSideEffects(g)])); effectsCache.set(catalog, m); }
  return m.get(id);
}

// Text that may not be an order: a question, discussion, hypothetical or quote (patterns borrowed from router, guard, clarify).
// A polite order ("can you pause the music?") is still an order: its '?' and question shape do not count.
const POLITE = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\b|please\b)/i;
// FACT's question-word head only: its unanchored read/article/section alternative (capture group 1) says nothing about intent
const asksFact = t => { const m = FACT.exec(t); return !!m && m[1] === undefined; };
function looksUnsure(text, lastGroups) {
  const t = String(text || '').trim();
  // polite head: the '?' is courtesy, but what follows can still be a question ("can you explain how to delete...")
  const rest = t.replace(POLITE, '').trim();
  const question = rest !== t ? asksFact(rest) : /\?\s*$/.test(t) || asksFact(t);
  return question || NOT_CLAIM.test(t) || QUOTED.test(t) || !!clarify(t, { lastGroups });
}

// Model only for the owner, with a constrain-capable provider, and only when the rule match is unsure or a
// high-confidence match would change something on text that may not be an order. High + read-only never calls.
function gate({ text, rule, catalog, provider, owner = false, lastGroups = [] }) {
  if (owner !== true) return { call: false, why: 'not owner' };
  if (!provider || typeof provider.constrain !== 'function') return { call: false, why: 'no provider' };
  const conf = rule?.confidence;
  if (conf === 'low' || conf === 'medium') return { call: true, why: `rule ${conf}` };
  const risky = (rule || []).some(id => id !== 'core' && RISKY.has(effectsOf(catalog, id)));
  if (risky && looksUnsure(text, lastGroups)) return { call: true, why: 'side effect on unsure text' };
  return { call: false, why: risky ? 'high, plain command' : 'high, read-only' };
}

// Lexical index over the cards (label, summary, examples, group hint), one per catalog.
const rankers = new WeakMap();
function cardRanker(catalog) {
  let r = rankers.get(catalog);
  if (!r) {
    r = createRanker(catalog.groups.filter(g => g.id !== 'core').map(g => {
      const c = buildCard(g, null);
      return { name: g.id, aliases: [c.label], hint: c.summary, description: g.hint || '', examples: c.examples };
    }));
    rankers.set(catalog, r);
  }
  return r;
}

const cardVecs = new WeakMap();   // catalog -> Promise<Map<id, vector>>; a failed embed is retried next turn
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };
const within = (p, ms) => { let t; return Promise.race([p, new Promise(res => { t = setTimeout(res, ms, null); })]).finally(() => clearTimeout(t)); };

async function semantic(text, catalog, embed, ms) {
  let vp = cardVecs.get(catalog);
  if (!vp) {
    const gs = catalog.groups.filter(g => g.id !== 'core');
    vp = Promise.resolve(embed(gs.map(g => { const c = buildCard(g, null); return `${c.label}: ${c.summary} ${c.examples.join('; ')}`; }), { role: 'doc' }))
      .then(v => new Map(gs.map((g, i) => [g.id, v[i]])));
    cardVecs.set(catalog, vp);
    vp.catch(() => cardVecs.delete(catalog));
  }
  const got = await within(Promise.all([vp, Promise.resolve(embed([String(text)], { role: 'query' })).then(v => v[0])]).catch(() => null), ms);
  if (!got) return null;
  const [vecs, q] = got;
  return new Map([...vecs].map(([id, v]) => [id, cosine(q, v)]));
}

// Card ids ranked by relevance, at most `k` plus `keep` (rule and last-turn groups always stay in).
async function shortlist(text, catalog, { embed, keep = [], k = SHORTLIST, embedMs = EMBED_MS } = {}) {
  const ids = catalog.groups.map(g => g.id).filter(id => id !== 'core');
  const lex = new Map(cardRanker(catalog).rank(text).map(r => [r.name, r.score]));
  const top = Math.max(0, ...lex.values()) || 1;
  let sem = null;
  if (typeof embed === 'function') { try { sem = await semantic(text, catalog, embed, embedMs); } catch { sem = null; } }
  const score = id => (lex.get(id) || 0) / top + (sem ? Math.max(0, sem.get(id) || 0) : 0);
  const ranked = ids.map((id, i) => ({ id, i, s: score(id) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.id);
  const out = ranked.slice(0, k);
  for (const id of keep) if (ids.includes(id) && !out.includes(id)) out.push(id);
  return out;
}

// The catalog as the interpreter sees it: only the shortlisted groups (core stays; interpret never offers it).
function view(catalog, ids) {
  const keep = new Set(['core', ...ids]);
  const groups = catalog.groups.filter(g => keep.has(g.id));
  return { ...catalog, groups, ids: groups.map(g => g.id), cardsNow: async () => (await catalog.cardsNow()).filter(c => keep.has(c.id)) };
}

// The ids still usable now, by the same rule as validateIntent: down groups out, unknown write/external out (fail closed).
async function usable(catalog, ids) {
  let cards = [];
  try { cards = typeof catalog.cardsNow === 'function' ? await catalog.cardsNow() : []; } catch { cards = null; }
  const byId = new Map((cards || []).map(c => [c.id, c]));
  return ids.filter(id => {
    const c = byId.get(id);
    const avail = cards === null ? null : c ? c.available : true;
    if (avail === false) return false;
    return !(avail === null && RISKY.has(c?.sideEffects || effectsOf(catalog, id)));
  });
}

const withConf =(arr, conf) => { Object.defineProperty(arr, 'confidence', { value: conf, enumerable: false }); return arr; };
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// resolveSelection({ text, rule?, history?, lastGroups?, hint?, live?, catalog, provider?, embed?, owner?, budgetMs?, signal?, hints?, now? })
async function resolveSelection({ text, rule, history, lastGroups = [], hint, live, catalog, provider, embed, owner = false, budgetMs = BUDGET_MS, signal, hints, now = Date.now } = {}) {
  const r = rule || selectGroups(text, { lastGroups }, catalog);
  const ruleGroups = [...r];
  const decision = { kind: null, confidence: null, reasoning: '', status: 'skipped', ms: 0, ruleGroups, finalGroups: ruleGroups, gated: true, why: '' };
  const asRule = extra => ({ action: 'act', groups: r, source: 'rule', ...extra, decision });
  const g = gate({ text, rule: r, catalog, provider, owner, lastGroups });
  decision.why = g.why;
  // a guest or unsure speaker never reaches the model, but still gets the fixed, model-free clarify answer the old path gave
  // (gate stays closed: the route payload stays plain)
  if (!g.call && owner !== true && r.confidence === 'low' && provider && typeof provider.constrain === 'function') {
    const hit = clarify(text, { lastGroups });
    if (hit) { decision.status = 'rule'; decision.why = `clarify ${hit.kind} (not owner)`; return hit.kind === 'ask' ? { action: 'ask', groups: r, source: 'rule', ask: hit.reply, decision } : { action: 'decline', groups: r, source: 'rule', decline: hit.reply, decision }; }
  }
  if (!g.call) return asRule();   // the simple-command path: no await on anything slow, no provider touch

  decision.gated = false;
  // the hand-written ask/decline rules answer an unmatched turn first, as selectWithModel always did
  if (r.confidence === 'low') {
    const hit = clarify(text, { lastGroups });
    if (hit) { decision.status = 'rule'; decision.why = `clarify ${hit.kind}`; return hit.kind === 'ask' ? { action: 'ask', groups: r, source: 'rule', ask: hit.reply, decision } : { action: 'decline', groups: r, source: 'rule', decline: hit.reply, decision }; }
  }
  const t0 = now();
  const prev = lastGroups.filter(id => id !== 'core' && catalog.ids.includes(id));
  let cat = catalog;
  if (catalog.ids.length - 1 > SHORTLIST) {
    const ids = await shortlist(text, catalog, { embed, keep: [...ruleGroups.filter(id => id !== 'core'), ...prev], embedMs: Math.min(EMBED_MS, budgetMs / 4) });
    cat = view(catalog, ids);
  }
  const intent = await interpret({ text, history, lastGroups, hint, live, catalog: cat, provider, budgetMs: Math.max(1, budgetMs - (now() - t0)), signal, hints, now });
  Object.assign(decision, { kind: intent.kind, confidence: intent.confidence, reasoning: intent.reasoning, status: intent.status, ms: Math.max(0, now() - t0) });
  if (intent.status !== 'ok') return asRule({ intent });   // graceful fallback: the rule result, unchanged

  let picked = intent.groups.filter(id => catalog.ids.includes(id));
  // a continuation with no new area reuses the last ones, but never past an honest decline or a group that is down now
  // group statuses may be slow: they share the turn's budget, and running out keeps the rule result
  if (!picked.length && !intent.decline && ['followup', 'correction', 'modify'].includes(intent.kind)) {
    const ok = await within(usable(catalog, prev), Math.max(1, budgetMs - (now() - t0)));
    if (!ok) { decision.status = 'timeout'; return asRule({ intent }); }
    picked = ok;
  }
  if (!picked.length) {
    if (intent.decline) return { action: 'decline', groups: r, source: 'model', decline: intent.decline, intent, decision };
    if (intent.ask) return { action: 'ask', groups: r, source: 'model', ask: intent.ask, intent, decision };
    if (intent.kind === 'chat' && intent.confidence >= ACT_MIN) {
      const groups = withConf(['core', ...(catalog.ids.includes('knowledge') ? ['knowledge'] : [])], 'medium');
      decision.finalGroups = [...groups];
      return { action: 'act', groups, source: sameSet(groups, ruleGroups) ? 'rule' : 'model', intent, decision };
    }
    // the model named no area (and this is not confident chat): a rule pick that changes things asks rather than acts
    if (ruleGroups.some(id => id !== 'core' && RISKY.has(effectsOf(catalog, id)))) {
      return { action: 'ask', groups: r, source: 'rule', ask: intent.ask || ASK_TEXT, intent, decision };
    }
    return asRule({ intent });
  }
  // a sure (or the only) reading replaces the rule pick; an unsure one is added to the rule's own matches (model's pick first,
  // so the cap never cuts the group the ask below must see)
  const ruleOwn = r.confidence === 'low' ? [] : ruleGroups.filter(id => id !== 'core');
  const merged = intent.confidence >= ACT_MIN || !ruleOwn.length ? picked : [...new Set([...picked, ...ruleOwn])];
  const cap = picked.length > 1 ? MULTI_MAX : MAX_GROUPS;
  const final = merged.slice(0, cap);
  const groups = withConf(['core', ...final], 'medium');
  decision.finalGroups = [...groups];
  const source = sameSet(final, ruleOwn) ? 'rule' : final.some(id => ruleOwn.includes(id)) ? 'merged' : 'model';
  if (intent.confidence < ACT_MIN && final.some(id => RISKY.has(effectsOf(catalog, id)))) {
    return { action: 'ask', groups, source, ask: intent.ask || ASK_TEXT, intent, decision };
  }
  return { action: 'act', groups, source, intent, decision };
}

module.exports = { resolveSelection, gate, shortlist, looksUnsure, SHORTLIST, MULTI_MAX, ACT_MIN };
