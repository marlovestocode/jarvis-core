// Which tool a request is about, ranked offline: a small lexical index (BM25-style) over every tool's name, aliases, hint and description.
//   createRanker(tools) → { rank(text, { only }) → [{ name, score }] best first, best(text) → { name, score, margin } | null }
// No model and no regex per phrasing: a new tool is findable the moment it has a good description. Three uses:
//   1. the tools of a loaded group are offered best-match first (small models favour the first tools in the list);
//   2. a request the router took for quick chat but that clearly names a tool's job is upgraded to a tool turn;
//   3. scripts/orchestration-bench.js measures how often the right tool is in the top 1 and top 3 (offline).
const STOP = new Set('a an the and or of to in on at for with from by is are was be it its my me i you your this that these those do does did can could would will please jarvis hey what whats how when where who why which about up down out off into over as if then than so just some any all not no yes'.split(' '));
const FIELD = { name: 3, alias: 2, hint: 1.5, description: 1 };
const K1 = 1.2, B = 0.5;

const stem = w => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w.replace(/s$/, ''));
function tokens(text) {
  return String(text || '').toLowerCase().replace(/[_\-./:]+/g, ' ').match(/[a-z0-9]+/g)?.filter(w => !STOP.has(w) && w.length > 1).map(stem) || [];
}

function createRanker(tools, { learned = 1.5, maxLearned = 40 } = {}) {
  const docs = tools.map(t => {
    const tf = new Map();
    const add = (text, w) => { for (const tok of tokens(text)) tf.set(tok, (tf.get(tok) || 0) + w); };
    add(t.name, FIELD.name);
    for (const a of t.aliases || []) add(a, FIELD.alias);
    add(t.hint, FIELD.hint);
    add(t.description, FIELD.description);
    for (const e of t.examples || []) add(e, FIELD.hint);
    return { name: t.name, tf, len: 0, seen: [] };
  });
  const byName = new Map(docs.map(d => [d.name, d]));
  let avg = 1;
  const df = new Map();
  let dirty = true;
  function prep() {
    df.clear();
    let total = 0;
    for (const d of docs) {
      d.len = 0;
      for (const [tok, v] of d.tf) { d.len += v; df.set(tok, (df.get(tok) || 0) + 1); }
      total += d.len;
    }
    avg = total / (docs.length || 1) || 1;
    dirty = false;
  }
  const idf = tok => Math.log(1 + (docs.length - (df.get(tok) || 0) + 0.5) / ((df.get(tok) || 0) + 0.5));

  // A tool that ran well for a request teaches the index that request's words (the tool's own text never knew "outside" meant the weather).
  // Capped per tool, oldest forgotten first, so one odd request cannot take over a tool.
  function learn(text, name) {
    const d = byName.get(name);
    const toks = [...new Set(tokens(text))];
    if (!d || !toks.length) return false;
    d.seen.push(toks);
    for (const tok of toks) d.tf.set(tok, (d.tf.get(tok) || 0) + learned);
    if (d.seen.length > maxLearned) {
      for (const tok of d.seen.shift()) { const v = (d.tf.get(tok) || 0) - learned; if (v > 0.001) d.tf.set(tok, v); else d.tf.delete(tok); }
    }
    dirty = true;
    return true;
  }
  const history = () => docs.filter(d => d.seen.length).map(d => ({ name: d.name, requests: d.seen.map(t => t.join(' ')) }));

  function rank(text, { only } = {}) {
    if (dirty) prep();
    const q = [...new Set(tokens(text))];
    if (!q.length) return [];
    const out = [];
    for (const d of docs) {
      if (only && !only.has(d.name)) continue;
      let s = 0;
      for (const tok of q) {
        const f = d.tf.get(tok);
        if (f) s += idf(tok) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avg));
      }
      if (s > 0) out.push({ name: d.name, score: Math.round(s * 1000) / 1000 });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function best(text, opts) {
    const r = rank(text, opts);
    if (!r.length) return null;
    return { name: r[0].name, score: r[0].score, margin: r[0].score - (r[1]?.score || 0) };
  }

  // the specs in the order the model should see them: best match first, the rest as they were (a stable sort)
  function order(text, specs) {
    const score = new Map(rank(text, { only: new Set(specs.map(t => t.name)) }).map(r => [r.name, r.score]));
    if (!score.size) return specs;
    return specs.map((t, i) => ({ t, i })).sort((a, b) => (score.get(b.t.name) || 0) - (score.get(a.t.name) || 0) || a.i - b.i).map(x => x.t);
  }

  return { rank, best, learn, history, order };
}

module.exports = { createRanker, tokens };
