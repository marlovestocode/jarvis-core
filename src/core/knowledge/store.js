// Looked-up knowledge in the cortex (cortex wave 3 §2–§3): what lookup_knowledge, read_article, web_search and web_open
// fetched is kept as a `knowledge` node with its source, a quote, the URL and the fetch time, and reused before going
// online while it is fresh. Distillation is mechanical: the stored text is the passage text the tool already produced.
// Only the public cortex verbs are used. Writes are always tainted (these tools read outside text), so they can only
// ever carry wiki (70) or web (40) trust. A write the cortex refuses never breaks the lookup that produced it.
const { ftsTokens } = require('../cortex/guard');
const { recency } = require('../cortex/recall');
const { entityKey } = require('../memory/facts');
const { describeAge } = require('./age');

const DAY = 864e5;
const TTL = Object.freeze({ stable: 90 * DAY, 'news-ish': 3 * DAY });
const MAX_TEXT = 2000, MAX_QUOTE = 240, MAX_SLUG = 120;
const REUSE_THETA = 0.55, REUSE_MAX = 1.3, REUSE_COVERAGE = 2 / 3, RECALL_BUDGET = 6000;
// current things: a price, a score, "the latest" — never stored, only logged (plan E4)
const VOLATILE = /\b(?:latest|current(?:ly)?|today|tonight|right now|now|this (?:week|morning|afternoon|evening)|breaking|live|price|prices|cost|stock|shares?|exchange rate|score|scores|weather|forecast)\b/i;
const SOURCE_KINDS = new Set(['wiki', 'web']);

const slug = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/, '');
const iso = ms => new Date(ms).toISOString();
const cutWords = (s, max) => {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  const c = t.slice(0, max + 1).replace(/\s+\S*$/, '');
  return (c.length ? c : t.slice(0, max)).trim();
};
const hostOf = url => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const words = s => new Set(String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

function createKnowledgeStore({ cortex, now = Date.now, log = () => {}, bus = null }) {
  const classify = text => (VOLATILE.test(String(text ?? '')) ? 'volatile' : null);

  const keyFor = ({ host, title, section } = {}) => `kn:${host}:${slug(title)}${section === undefined || section === null ? '' : '#' + (slug(section) || 'article')}`;

  // a page address → its key; a Wikipedia article page shares the key of the same article read through the wiki API
  function keyForUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const m = /(^|\.)wikipedia\.org$/.test(host) && u.pathname.match(/^\/wiki\/([^/]+)$/);
    if (m) {
      let title;
      try { title = decodeURIComponent(m[1]).replace(/_/g, ' '); } catch { title = m[1].replace(/_/g, ' '); }
      return { key: keyFor({ host: 'wikipedia.org', title }), host, title };
    }
    return { key: `kn:${host}:${slug(u.pathname + u.search) || 'home'}`, host };
  }

  const event = payload => { try { cortex.event.add({ kind: 'lookup', nodeId: payload.nodeId ?? null, payload: { ...payload, nodeId: undefined } }); } catch (err) { log('knowledge event: ' + err.message); } };
  const topKind = n => n?.sources?.[0]?.kind ?? null;   // sources come highest trust first
  const sourceFor = (kind, url, title) => cortex.source.find({ kind, ref: url }) ?? cortex.source.add({ kind, ref: url, title });

  function linkEntity(id, title) {
    if (!title) return;
    const ent = cortex.node.find({ kind: 'entity', key: entityKey(title) });
    if (ent && ent.status === 'active' && ent.id !== id) cortex.link(id, ent.id, 'about', { weight: 0.5 });
  }

  // save → { id, conflict?, refreshed? } | { skipped }; never throws
  function save({ key, host, title, section, url, text, sourceKind, ttlClass = 'news-ish', tool, query } = {}) {
    if (!SOURCE_KINDS.has(sourceKind)) return { skipped: 'source' };
    if (classify(query) === 'volatile') { event({ tool, host, volatile: true }); return { skipped: 'volatile' }; }
    try {
      const body = cutWords(text, MAX_TEXT);
      const data = { url, title, ...(section ? { section } : {}), fetchedAt: iso(now()), ttlClass: TTL[ttlClass] ? ttlClass : 'news-ish' };
      const src = sourceFor(sourceKind, url, title);
      const write = { kind: 'knowledge', text: body, data, source: src, quote: body.slice(0, MAX_QUOTE), tainted: true };
      const cur = cortex.node.find({ kind: 'knowledge', key });
      let res;
      if (cur && topKind(cur) === sourceKind) {
        // a refresh from the same kind of source: in place, no archived copy per refresh (plan E8)
        cortex.node.update(cur.id, { text: body, data, ...(cur.status !== 'active' ? { status: 'active' } : {}) }, { source: src, tainted: true });
        res = { id: cur.id, refreshed: true };
      } else if (cur && sourceKind === 'web' && topKind(cur) === 'wiki') {
        // lower trust on a wiki slot: one contradicting node per slot and source kind, refreshed in place after the first
        const mine = cortex.neighbors(cur.id, { types: ['contradicts'], limit: 20 }).map(n => cortex.node.get(n.id))
          .find(n => n && n.kind === 'knowledge' && n.data?._slot === key && topKind(n) === sourceKind);
        if (mine) {
          cortex.node.update(mine.id, { text: body, data: { ...data, _slot: key }, status: 'active' }, { source: src, tainted: true });
          res = { id: mine.id, conflict: 'contradicts', refreshed: true };
        } else res = cortex.node.upsert({ ...write, key });
      } else res = cortex.node.upsert({ ...write, key });
      const out = { id: res.id, ...(res.conflict ? { conflict: res.conflict } : {}), ...(res.refreshed ? { refreshed: true } : {}) };
      try { linkEntity(out.id, title); } catch (err) { log('knowledge link: ' + err.message); }
      event({ tool, host, stored: true, nodeId: out.id });
      return out;
    } catch (err) {
      log(`knowledge not stored (${err.code || err.message})`);
      return { skipped: 'refused', reason: err.code || err.message };
    }
  }

  function toHit(n) {
    if (!n || n.kind !== 'knowledge') return null;
    const d = n.data || {};
    const at = Date.parse(d.fetchedAt);
    const fetchedAt = Number.isFinite(at) ? at : n.updated;
    const ageMs = Math.max(0, now() - fetchedAt);
    const conflicts = [];
    try {
      for (const e of cortex.neighbors(n.id, { types: ['contradicts'], limit: 5 })) {
        const o = cortex.node.get(e.id);
        if (!o || o.status !== 'active' || o.kind !== 'knowledge') continue;
        conflicts.push({ sourceKind: topKind(o), host: hostOf(o.data?.url) || 'unknown site', quote: (o.sources?.[0]?.quote || o.text).slice(0, MAX_QUOTE) });
      }
    } catch (err) { log('knowledge conflicts: ' + err.message); }
    return { id: n.id, key: n.key, text: n.text, url: d.url, title: d.title, host: hostOf(d.url) || 'unknown site', sourceKind: topKind(n),
      fetchedAt, ageMs, stale: ageMs > (TTL[d.ttlClass] ?? TTL['news-ish']), conflicts };
  }

  // the stored node under an exact key (read_article, web_open)
  function get(key, { allowStale = false } = {}) {
    try {
      const n = cortex.node.find({ kind: 'knowledge', key });
      if (!n || n.status !== 'active') return null;
      const hit = toHit(n);
      return hit && (!hit.stale || allowStale) ? hit : null;
    } catch (err) { log('knowledge get: ' + err.message); return null; }
  }

  // a node by id as a hit, stale or not (to tell the conflicts of a node just written)
  function byId(id) {
    try { return toHit(cortex.node.get(id)); } catch (err) { log('knowledge get: ' + err.message); return null; }
  }

  // the best confident stored answer to a question (plan E5): relevance (recall score without its recency decay,
  // since freshness is the TTL's job) ≥ θ of the max, and ≥ 2/3 of the question's words in the node's title and text
  async function find(query, { allowStale = false } = {}) {
    const toks = ftsTokens(query);
    if (!toks.length) return null;
    const need = Math.ceil(toks.length * REUSE_COVERAGE);
    try {
      const r = await cortex.recall(String(query), { kinds: ['knowledge'], budget: RECALL_BUDGET });
      for (const it of r.items) {
        const n = cortex.node.get(it.id);
        if (!n || n.status !== 'active') continue;
        if (it.score / recency(n.last_used ?? n.updated, now()) < REUSE_THETA * REUSE_MAX) continue;
        const have = words(`${n.data?.title || ''} ${n.text}`);
        if (toks.filter(w => have.has(w)).length < need) continue;
        const hit = toHit(n);
        if (hit && (!hit.stale || allowStale)) return hit;
      }
    } catch (err) { log('knowledge find: ' + err.message); }
    return null;
  }

  const name = hit => (hit.sourceKind === 'wiki' ? 'Wikipedia' : `web: ${hit.host}`);
  const label = hit => (hit.stale
    ? `${name(hit)}, last known, from ${iso(hit.fetchedAt).slice(0, 10)} (could not refresh)`
    : `${name(hit)}, from memory, fetched ${describeAge(hit.ageMs)}`);

  const conflictNote = hit => (hit?.conflicts || []).map(c =>
    `\nAnother source (${c.sourceKind === 'wiki' ? 'wikipedia' : 'web'}, ${c.host}) says differently: "${c.quote.replace(/"""/g, '"')}". Tell the user both and which is more reliable.`).join('');

  // a served hit counts as a reuse: uses +1, an event, and a 'net' event the turn shows as "from memory"
  function reused(hit, tool) {
    try { cortex.reinforce([hit.id]); } catch (err) { log('knowledge reuse: ' + err.message); }
    event({ tool, host: hit.host, reused: true, nodeId: hit.id });
    try { bus?.emit('net', { source: 'cortex', host: hit.host, ok: true, cached: true, ageMs: hit.ageMs, stale: hit.stale }); } catch { /* listeners */ }
  }

  return { classify, keyFor, keyForUrl, save, get, byId, find, label, conflictNote, reused, TTL };
}

module.exports = { createKnowledgeStore, REUSE_THETA, REUSE_COVERAGE, TTL };
