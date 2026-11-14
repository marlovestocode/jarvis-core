'use strict';
// Tool-level discovery (spec 2, Phase 2b): which TOOLS fit a request, ranked by lexical (BM25) and embedding scores over the
// same card text. It only OFFERS tools to the model: exec() in tools/registry.js stays the one authority on what may run, so
// ineligible tools (guest, tainted) are hidden here and reported, never trusted to guard anything.
//   createToolIndex({ catalog, embed?, embedMs?, eligible? }) -> { find(text, opts) }
const { createRanker } = require('./rank');
const { cardText } = require('./toolcards');
const { cosine, within } = require('./discover');

// Initial values; tuned on the dev fixtures only (Task 8).
const TOOL_K = 6, K_MIN = 4, K_MAX = 8;
const MIN_COS = 0.3;      // an embedding match this weak is no match
const READ_DAMP = 0.6;    // a question about state: write/external tools count for less
const META = new Set(['find_tools', 'more_skills']);   // how the model asks for tools, never a candidate itself

function createToolIndex({ catalog, embed = null, embedMs = 250, eligible = () => null } = {}) {
  // keyed on the catalog: the card text and the tool vectors are built once, not per turn
  const built = new WeakMap();   // catalog -> Promise<{ rows, ranker }>
  const vecs = new WeakMap();    // catalog -> Promise<Map<name, vector>>; a failed batch is retried next turn

  function state() {
    let p = built.get(catalog);
    if (!p) {
      p = (async () => {
        const cards = await catalog.toolCardsNow();
        const rows = [...cards.values()].filter(c => !META.has(c.name)).map(card => {
          const tool = catalog.byName.get(card.name)?.tool || { name: card.name };
          return { card, tool, text: cardText(card, tool) };
        });
        return { rows, ranker: createRanker(rows.map(r => ({ name: r.card.name, description: r.text }))) };
      })();
      built.set(catalog, p);
      p.catch(() => built.delete(catalog));
    }
    return p;
  }

  function vectors(rows) {
    let p = vecs.get(catalog);
    if (!p) {
      // one batch; it may finish after this turn's cap, the turn that started it simply falls back to lexical
      p = Promise.resolve().then(() => embed(rows.map(r => r.text), { role: 'doc' })).then(v => {
        if (!Array.isArray(v) || v.length !== rows.length) throw new Error('bad embedding batch');
        return new Map(rows.map((r, i) => [r.card.name, v[i]]));
      });
      vecs.set(catalog, p);
      p.catch(() => vecs.delete(catalog));
    }
    return p;
  }

  // availability can change between turns; a slow or failing status keeps what was last known. Skipped on lexicalOnly (simple
  // command) turns: they must not wait on any status probe, and the rule-picked group is tried either way.
  async function availability(st, lexicalOnly) {
    if (lexicalOnly) return;
    try {
      const cards = await within(catalog.toolCardsNow(), embedMs);
      if (cards) for (const r of st.rows) { const c = cards.get(r.card.name); if (c) r.card = c; }
    } catch { /* keep the cards as they were */ }
  }

  async function find(text, { groups = null, speaker = 'owner', tainted = false, exclude = new Set(), effectHint = null, lexicalOnly = false, k } = {}) {
    const none = { outcome: 'none', tools: [], ineligible: [], mode: 'lexical' };
    // a slow status probe must not stall the turn (simple commands included): no index this turn, the caller keeps its loaded set
    let st;
    try { st = await within(state(), embedMs); } catch { st = null; }
    if (!st) return { ...none, outcome: 'unavailable' };
    await availability(st, lexicalOnly);
    const gset = groups ? new Set(groups) : null;
    const cand = st.rows.filter(r => r.card.available !== false && !exclude.has(r.card.name) && (!gset || gset.has(r.card.groupId)));
    if (!cand.length) return none;

    const lex = new Map(st.ranker.rank(text, { only: new Set(cand.map(r => r.card.name)) }).map(r => [r.name, r.score]));
    const top = Math.max(0, ...lex.values()) || 1;
    let sem = null;
    if (!lexicalOnly && typeof embed === 'function') {
      try {
        const q = Promise.resolve().then(() => embed([String(text)], { role: 'query' })).then(v => v[0]);
        const got = await within(Promise.all([vectors(st.rows), q]).catch(() => null), embedMs);
        if (got) { const [vm, qv] = got; sem = new Map([...vm].map(([n, v]) => [n, cosine(qv, v)])); }
      } catch { sem = null; }
    }

    const scored = [];
    for (const r of cand) {
      const l = lex.get(r.card.name) || 0, c = sem ? sem.get(r.card.name) || 0 : 0;
      if (!(l > 0 || c >= MIN_COS)) continue;
      let s = l / top + Math.max(0, c);
      if (effectHint === 'read' && r.card.effect !== 'read') s *= READ_DAMP;
      scored.push({ r, s });
    }
    const mode = sem ? 'hybrid' : 'lexical';
    scored.sort((a, b) => b.s - a.s || (a.r.card.name < b.r.card.name ? -1 : 1));
    if (!scored.length) return { ...none, mode };

    const ok = [], ineligible = [];
    for (const x of scored) {
      const reason = eligible(x.r.tool, { speaker, tainted });
      if (reason) ineligible.push({ name: x.r.card.name, groupId: x.r.card.groupId, reason });
      else ok.push(x);
    }
    if (!ok.length) return { outcome: 'not_permitted', tools: [], ineligible, mode };

    // a clear winner needs few neighbours; a weak best match gets a wider net
    const norm = ok[0].s / (sem ? 2 : 1);
    const n = k || (ok.length > 1 && ok[0].s >= 1.5 * ok[1].s ? K_MIN : norm < 0.6 ? K_MAX : TOOL_K);
    const tools = ok.slice(0, n).map(x => ({ name: x.r.card.name, groupId: x.r.card.groupId, score: Math.round(x.s * 1000) / 1000 }));
    return { outcome: 'tools', tools, ineligible, mode };
  }

  return { find };
}

module.exports = { createToolIndex, TOOL_K, K_MIN, K_MAX };
