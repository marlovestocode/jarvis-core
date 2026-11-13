// A read-only picture of the cortex for the wallpaper's neural lattice.
//   view()   the shape only: the most-used active nodes (id, kind, weight, uses) and the links among them (effective weight,
//            decayed to now). No text, so it is safe on the event bridge.
//   labels() a few words for some node ids. Only the bridge's stricter route serves these, and only when the user allows it.
const { effective, TYPES } = require('./edges');

const TYPE_NAMES = Object.keys(TYPES);
const MAX_FOCUS = 24;
const MAX_LABEL_IDS = 24;
const LABEL_CHARS = 28;
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);
const r2 = v => Math.round(v * 100) / 100;

function createBrainView(db, { now = Date.now } = {}) {
  // opts { max (40..800, default 360), maxEdges (40..2000, default 900), focus: [ids that must be included, e.g. what just fired] }
  function view(opts = {}) {
    const max = clamp(opts.max, 40, 800, 360), maxEdges = clamp(opts.maxEdges, 40, 2000, 900);
    const focus = [...new Set((Array.isArray(opts.focus) ? opts.focus : []).map(Number).filter(Number.isInteger))].slice(0, MAX_FOCUS);

    // the nodes that matter most: important and often used first, then the most recently touched
    const top = db.stmt(`SELECT id, kind, importance, uses, created FROM node WHERE status = 'active'
                         ORDER BY (importance * 0.5 + MIN(uses, 40) / 40.0 * 0.5) DESC, COALESCE(last_used, updated) DESC LIMIT ?`).all(max);
    const seen = new Set(top.map(n => n.id));
    const extra = focus.filter(id => !seen.has(id));
    if (extra.length) {
      for (const n of db.stmt(`SELECT id, kind, importance, uses, created FROM node WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(extra))) { top.push(n); seen.add(n.id); }
    }

    const ids = JSON.stringify([...seen]);
    const t = now();
    const links = db.stmt(`SELECT src, dst, type, weight, last_used FROM edge
                           WHERE src IN (SELECT value FROM json_each(?1)) AND dst IN (SELECT value FROM json_each(?1))
                           ORDER BY weight DESC LIMIT ?2`).all(ids, maxEdges * 3)
      .map(e => [e.src, e.dst, effective(e.weight, e.last_used, e.type, t), Math.max(0, TYPE_NAMES.indexOf(e.type))])
      .filter(e => e[2] > 0.01)
      .sort((a, b) => b[2] - a[2])
      .slice(0, maxEdges)
      .map(e => [e[0], e[1], r2(e[2]), e[3]]);

    return {
      nodes: top.map(n => ({ id: n.id, k: n.kind, w: r2(n.importance), u: n.uses, c: n.created })),
      edges: links,
      types: TYPE_NAMES,
      total: { nodes: db.stmt(`SELECT count(*) n FROM node WHERE status = 'active'`).get().n, edges: db.stmt('SELECT count(*) n FROM edge').get().n },
      at: t,
    };
  }

  // { [id]: "a few words" } for the active nodes among the ids (first line of the text, trimmed)
  function labels(idList) {
    const ids = [...new Set((Array.isArray(idList) ? idList : []).map(Number).filter(Number.isInteger))].slice(0, MAX_LABEL_IDS);
    if (!ids.length) return {};
    const out = {};
    for (const r of db.stmt(`SELECT id, text FROM node WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))) {
      const s = String(r.text || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
      if (s) out[r.id] = s.length > LABEL_CHARS ? s.slice(0, LABEL_CHARS - 1).trimEnd() + '…' : s;
    }
    return out;
  }

  return { view, labels };
}

module.exports = { createBrainView, MAX_LABEL_IDS };
