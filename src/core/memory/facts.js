// Long-term memory on the cortex (W1 §2): short facts about the user as `fact` nodes, the people/pets/places they
// mention as `entity` nodes, and a review queue for facts proposed from past chats. Keeps the old memory.json store's
// surface (add/find/forget/clear/list/digest/count, same return shapes) so the skill, tools and tests are unchanged.
// Nothing here runs SQL: only the cortex verbs.
const { SECRET } = require('../cortex/guard');

const MAX_LEN = 200;
const PAGE = 1000;
const TIERS = new Set(['profile', 'note']);
const ENTITY_TYPES = new Set(['person', 'pet', 'place', 'project', 'org']);
const MAX_ENTITIES = 6;

const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'i', 'is', 'am', 'are', 'to', 'of', 'and', 'it', 'about', 'me', 'on', 'in']);
const words = s => norm(s).split(' ').filter(w => w && !STOP.has(w));
const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.!\s]+$/, '');
const entityKey = name => 'entity:' + String(name ?? '').toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim();

// text → null when fine, else the old store's reason
function invalid(t) {
  if (t.length < 3) return 'empty';
  if (t.length > MAX_LEN) return 'long';
  if (SECRET.test(t)) return 'secret';
  return null;
}

function createMemory({ cortex, now = Date.now, caps = {}, addTier = 'profile' } = {}) {
  const cap = { active: 300, pending: 50, ...caps };
  const sourceIds = new Map();
  // one user source per ref (the explicit "remember", the review tab, or the chat a proposal came from)
  function userSource(ref) {
    let id = sourceIds.get(ref);
    if (!id) { id = cortex.source.find({ kind: 'user', ref }) ?? cortex.source.add({ kind: 'user', ref }); sourceIds.set(ref, id); }
    return id;
  }

  function listAll(status, kind = 'fact') {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = cortex.node.list({ kind, status, limit: PAGE, offset, order: 'created' });
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }
  const oldestFirst = list => list.sort((a, b) => a.created - b.created || a.id - b.id);
  const activeFacts = () => oldestFirst(listAll('active'));
  const tierOf = n => (TIERS.has(n.data?.tier) ? n.data.tier : 'note');
  const isRejected = n => n.status === 'archived' && n.data?.rejected === true;
  // the chat a proposal came from is its user source's ref (never in `data`: a uuid can look like a card number to the secret check)
  const OWN_REFS = new Set(['remember', 'review', 'chat']);
  const sessionOf = id => cortex.node.get(id)?.sources.find(x => x.kind === 'user' && x.ref && !OWN_REFS.has(x.ref))?.ref ?? null;
  const item = n => ({ id: n.id, text: n.text, tier: tierOf(n), status: n.status, created: n.created, updated: n.updated, uses: n.uses, sessionId: sessionOf(n.id) });

  // the fact node with the same normalized text, active first, then pending, then archived
  function findSame(t) {
    const k = norm(t);
    for (const status of ['active', 'pending', 'archived']) {
      const hit = listAll(status).find(n => norm(n.text) === k);
      if (hit) return hit;
    }
    return null;
  }

  // room for one more active fact: at the cap the oldest note archives; profile facts never do
  function makeRoom() {
    const act = activeFacts();
    if (act.length < cap.active) return true;
    const note = act.find(n => tierOf(n) === 'note');
    if (!note) return false;
    cortex.node.archive(note.id);
    return true;
  }

  const linkedOf = (id, kind) => cortex.neighbors(id, { types: ['mentions'], depth: 1, limit: 50 })
    .map(n => cortex.node.get(n.id)).filter(n => n && n.kind === kind);

  function activateEntities(factId) {
    for (const e of linkedOf(factId, 'entity')) if (e.status === 'pending') cortex.node.update(e.id, { status: 'active' }, { source: userSource('review') });
  }

  // after a rejection or a wipe: a pending entity no live fact mentions goes (W1 E7)
  function dropOrphanEntities(entities, { keepChatLinked = false, onlyPending = true } = {}) {
    for (const e of entities) {
      if (onlyPending && e.status !== 'pending') continue;
      const around = cortex.neighbors(e.id, { depth: 1, limit: 50 }).map(n => cortex.node.get(n.id)).filter(Boolean);
      const live = around.some(n => (n.kind === 'fact' && (n.status === 'active' || n.status === 'pending')) || (keepChatLinked && n.kind === 'chat'));
      if (!live) cortex.node.remove(e.id);
    }
  }

  function approveNode(n, text) {
    if (!makeRoom()) return { ok: false, reason: 'full' };
    try {
      cortex.node.update(n.id, { status: 'active', ...(text !== undefined && { text }), data: { ...(n.data || {}), tier: tierOf(n), rejected: undefined } }, { source: userSource('review') });
    } catch (err) { return { ok: false, reason: err.code === 'secret' ? 'secret' : 'invalid' }; }
    activateEntities(n.id);
    return { ok: true, text: text ?? n.text };
  }

  // add(text) → { ok, text?, reason?, duplicate? } — the user's explicit "remember that…" (tier profile, W1 E4)
  function add(text) {
    const t = clean(text);
    const bad = invalid(t);
    if (bad) return { ok: false, reason: bad };
    const same = findSame(t);
    if (same?.status === 'active') return { ok: true, text: same.text, duplicate: true };
    if (same) {
      const r = approveNode({ ...same, data: { ...(same.data || {}), tier: addTier } });
      return r.ok ? { ok: true, text: same.text } : r;
    }
    if (!makeRoom()) return { ok: false, reason: 'full' };
    cortex.node.upsert({ kind: 'fact', text: t, data: { tier: addTier }, source: userSource('remember') });
    return { ok: true, text: t };
  }

  // propose(...) → { id } | { skipped } — a fact auto-extracted from the user's own words, waiting for review
  function propose({ text, tier = 'note', quote = null, sessionId = null, chatNodeId = null, entities = [] } = {}) {
    const t = clean(text);
    const bad = invalid(t);
    if (bad) return { skipped: bad === 'secret' ? 'secret' : 'invalid' };
    const same = findSame(t);
    if (same) return { skipped: isRejected(same) ? 'rejected' : 'duplicate' };
    if (listAll('pending').length >= cap.pending) return { skipped: 'full' };
    const ref = sessionId ? String(sessionId) : 'chat';
    let id;
    try {
      id = cortex.node.upsert({ kind: 'fact', text: t, status: 'pending', data: { tier: TIERS.has(tier) ? tier : 'note' },
        source: userSource(ref), quote }).id;
    } catch (err) { return { skipped: err.code === 'secret' ? 'secret' : 'invalid' }; }
    for (const e of (Array.isArray(entities) ? entities : []).slice(0, MAX_ENTITIES)) {
      const key = entityKey(e?.name);
      if (key.length <= 'entity:'.length) continue;
      try {
        const have = cortex.node.find({ kind: 'entity', key });
        const eid = have ? have.id : cortex.node.upsert({ kind: 'entity', key, text: String(e.name).trim(), status: 'pending',
          data: { type: ENTITY_TYPES.has(e.type) ? e.type : 'other' }, source: userSource(ref) }).id;
        cortex.link(id, eid, 'mentions', { weight: 0.5 });
      } catch { /* a name the cortex refuses (too short, secret) is just not linked */ }
    }
    if (Number.isInteger(chatNodeId)) { try { cortex.link(id, chatNodeId, 'from', { weight: 0.5 }); } catch { /* chat gone */ } }
    return { id };
  }

  const getFact = (id, statuses) => {
    const n = Number.isInteger(id) ? cortex.node.get(id) : null;
    return n && n.kind === 'fact' && statuses.includes(n.status) ? n : null;
  };

  function approve(id, { text } = {}) {
    const n = getFact(id, ['pending']);
    if (!n) return { ok: false, reason: 'not_found' };
    let t;
    if (text !== undefined) { t = clean(text); const bad = invalid(t); if (bad) return { ok: false, reason: bad }; }
    return approveNode(n, t);
  }

  function reject(id) {
    const n = getFact(id, ['pending']);
    if (!n) return { ok: false, reason: 'not_found' };
    const ents = linkedOf(id, 'entity');
    cortex.node.update(id, { status: 'archived', data: { ...(n.data || {}), rejected: true } }, { source: userSource('review') });
    dropOrphanEntities(ents);
    return { ok: true };
  }

  function edit(id, { text, tier } = {}) {
    const n = getFact(id, ['active', 'pending']);
    if (!n) return { ok: false, reason: 'not_found' };
    const patch = {};
    if (text !== undefined) { const t = clean(text); const bad = invalid(t); if (bad) return { ok: false, reason: bad }; patch.text = t; }
    if (tier !== undefined) { if (!TIERS.has(tier)) return { ok: false, reason: 'tier' }; patch.data = { ...(n.data || {}), tier }; }
    try { cortex.node.update(id, patch, { source: userSource('review') }); } catch (err) { return { ok: false, reason: err.code === 'secret' ? 'secret' : 'invalid' }; }
    return { ok: true };
  }

  function remove(id) {
    const n = getFact(id, ['active', 'pending', 'archived']);
    if (!n) return { ok: false, reason: 'not_found' };
    cortex.node.remove(id);
    return { ok: true };
  }

  const pending = () => oldestFirst(listAll('pending')).map(item);

  function active({ query = '', tier = null, limit = 50, offset = 0 } = {}) {
    const q = words(query);
    let list = activeFacts().reverse();
    if (tier) list = list.filter(n => tierOf(n) === tier);
    if (q.length) list = list.filter(n => { const t = norm(n.text); return q.every(w => t.includes(w)); });
    const off = Math.max(0, Number(offset) || 0), lim = Math.max(1, Math.min(500, Number(limit) || 50));
    return list.slice(off, off + lim).map(item);
  }

  // find(query) → [{ id, text, at }]; every query word must appear (or all but one, for queries of 3+ words)
  function find(query) {
    const q = words(query);
    if (!q.length) return [];
    return activeFacts().map(n => {
      const fw = new Set(words(n.text));
      return { n, hit: q.filter(w => fw.has(w)).length };
    }).filter(x => x.hit === q.length || (q.length >= 3 && x.hit >= q.length - 1))
      .sort((a, b) => b.hit - a.hit).map(x => ({ id: x.n.id, text: x.n.text, at: x.n.created }));
  }

  // forget(query) → { removed: [text], ambiguous?: [text] }; several matches are not deleted unless all=true
  function forget(query, { all = false } = {}) {
    const m = find(query);
    if (!m.length) return { removed: [] };
    if (m.length > 1 && !all) return { removed: [], ambiguous: m.map(f => f.text) };
    for (const f of m) cortex.node.remove(f.id);
    return { removed: m.map(f => f.text) };
  }

  // voice/chat "forget everything" (W1 E3): every fact but the rejected tombstones, and entities nothing else holds
  function clear() {
    let n = 0;
    const ents = [...listAll('active', 'entity'), ...listAll('pending', 'entity')];
    for (const status of ['active', 'pending', 'archived']) {
      for (const f of listAll(status)) {
        if (isRejected(f)) continue;
        cortex.node.remove(f.id);
        if (status !== 'archived') n++;
      }
    }
    dropOrphanEntities(ents, { keepChatLinked: true, onlyPending: false });
    return n;
  }

  const list = () => activeFacts().map(n => n.text);

  // profile facts for the system prompt: most used first, then newest, within a character budget
  function profile({ budget = 500 } = {}) {
    const facts = activeFacts().filter(n => tierOf(n) === 'profile')
      .sort((a, b) => (b.uses || 0) - (a.uses || 0) || b.created - a.created || b.id - a.id);
    const text = [], ids = [];
    let used = 0;
    for (const f of facts) {
      if (used + f.text.length + 3 > budget) break;
      text.push(f.text); ids.push(f.id); used += f.text.length + 3;
    }
    return { text: text.join('; '), ids };
  }
  const digest = (maxChars = 900) => profile({ budget: maxChars }).text;

  const count = () => listAll('active').length;
  const stats = () => ({ active: count(), pending: listAll('pending').length, rejected: listAll('archived').filter(isRejected).length, cap: cap.active });

  return { add, find, forget, clear, list, digest, count, propose, approve, reject, edit, remove, pending, active, profile, stats };
}

module.exports = { createMemory, entityKey, MAX_LEN };
