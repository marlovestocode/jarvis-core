// Cortex edges: weighted links that strengthen with use and fade with time (core spec §4.4).
// The stored weight is as of last_used; the effective weight decays by the type's half-life on read, so no job sweeps decay.
const { CortexError } = require('./guard');

const DAY = 864e5;
// half-life in days, fan-out cap per node (plan D8)
const TYPES = Object.freeze({
  mentions: { halfLife: 60, fanOut: 20 }, part_of: { halfLife: 365, fanOut: 20 }, from: { halfLife: 365, fanOut: 10 },
  by: { halfLife: 365, fanOut: 5 }, contains: { halfLife: 365, fanOut: 50 }, next: { halfLife: 90, fanOut: 10 },
  similar: { halfLife: 120, fanOut: 5 }, same_as: { halfLife: 3650, fanOut: 5 }, supersedes: { halfLife: 3650, fanOut: 2 },
  contradicts: { halfLife: 3650, fanOut: 5 }, touched: { halfLife: 30, fanOut: 20 }, about: { halfLife: 180, fanOut: 20 },
});
const STRUCTURAL = new Set(['supersedes', 'contradicts', 'same_as']);   // facts about records, not associations: never weakened
const ETA_LINK = 0.3, ETA_USE = 0.15, MAX_W = 1 - 1e-6, FLOOR = 0.02;

function effective(w, lastUsed, type, now) {
  const days = Math.max(0, now - lastUsed) / DAY;
  return w * Math.pow(0.5, days / (TYPES[type]?.halfLife ?? 60));
}
const clamp = w => Math.max(1e-6, Math.min(1, w));
const grow = (eff, eta) => Math.min(MAX_W, eff + eta * (1 - eff));

function createEdges(db, { now = Date.now } = {}) {
  const checkType = type => { if (!TYPES[type]) throw new CortexError('edge_type', 'unknown edge type: ' + type); };

  function link(src, dst, type, { weight } = {}) {
    checkType(type);
    if (src === dst) throw new CortexError('self_link');
    const t = now();
    const cur = db.stmt('SELECT weight, last_used FROM edge WHERE src = ? AND dst = ? AND type = ?').get(src, dst, type);
    if (!cur) {
      db.stmt('INSERT INTO edge(src, dst, type, weight, created, last_used) VALUES (?, ?, ?, ?, ?, ?)').run(src, dst, type, clamp(weight ?? ETA_LINK), t, t);
      return;
    }
    const eff = effective(cur.weight, cur.last_used, type, t);
    const w = weight === undefined ? grow(eff, ETA_LINK) : Math.max(eff, clamp(weight));
    db.stmt('UPDATE edge SET weight = ?, last_used = ?, uses = uses + 1 WHERE src = ? AND dst = ? AND type = ?').run(w, t, src, dst, type);
  }

  const unlink = (src, dst, type) => db.stmt('DELETE FROM edge WHERE src = ? AND dst = ? AND type = ?').run(src, dst, type).changes > 0;

  // One statement per set of types: for each type and direction, the 2×fanOut strongest stored weights by index.
  // Stored weight is as of last_used, so the effective order can differ a little; 2× headroom absorbs that.
  const aroundSql = new Map();
  function aroundStmt(types) {
    const list = types ? [...types].filter(x => TYPES[x]).sort() : Object.keys(TYPES);
    const key = list.join(',');
    let sql = aroundSql.get(key);
    if (!sql) {
      sql = list.flatMap(ty => {
        const k = TYPES[ty].fanOut * 2;
        return [`SELECT * FROM (SELECT dst AS other, type, weight, last_used FROM edge WHERE src = ?1 AND type = '${ty}' ORDER BY weight DESC LIMIT ${k})`,
          `SELECT * FROM (SELECT src AS other, type, weight, last_used FROM edge WHERE dst = ?1 AND type = '${ty}' ORDER BY weight DESC LIMIT ${k})`];
      }).join(' UNION ALL ') || 'SELECT 0 AS other, NULL AS type, 0 AS weight, 0 AS last_used WHERE 0';
      aroundSql.set(key, sql);
    }
    return db.stmt(sql);
  }

  // both directions of one node, effective weights, fan-out capped per type
  function around(id, t, types) {
    const rows = aroundStmt(types).all(id);
    const out = [];
    for (const r of rows) out.push({ id: r.other, type: r.type, weight: effective(r.weight, r.last_used, r.type, t) });
    out.sort((a, b) => b.weight - a.weight);
    const per = {};
    return out.filter(e => (per[e.type] = (per[e.type] || 0) + 1) <= TYPES[e.type].fanOut);
  }

  function neighbors(id, { types, depth = 1, limit = 20 } = {}) {
    const t = now(), set = types ? new Set(types) : null;
    const seen = new Set([id]), out = [];
    let frontier = [{ id, weight: 1 }];
    for (let hop = 1; hop <= Math.max(1, Math.min(3, depth)); hop++) {
      const next = [];
      for (const f of frontier) for (const e of around(f.id, t, set)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const n = { id: e.id, type: e.type, weight: f.weight * e.weight, hop, via: f.id };
        out.push(n); next.push(n);
      }
      frontier = next;
    }
    return out.sort((a, b) => a.hop - b.hop || b.weight - a.weight).slice(0, Math.max(1, limit));
  }

  // Hebbian co-use: existing edges between each pair (either direction, any type) grow by eta
  function strengthen(pairs, eta = ETA_USE) {
    const t = now();
    db.tx(() => {
      for (const [a, b] of pairs || []) {
        const rows = db.stmt('SELECT src, dst, type, weight, last_used FROM edge WHERE (src = ?1 AND dst = ?2) OR (src = ?2 AND dst = ?1)').all(a, b);
        for (const r of rows) db.stmt('UPDATE edge SET weight = ?, last_used = ?, uses = uses + 1 WHERE src = ? AND dst = ? AND type = ?')
          .run(grow(effective(r.weight, r.last_used, r.type, t), eta), t, r.src, r.dst, r.type);
      }
    });
  }

  // a correction after a recall: edges touching those nodes lose 40% (structural edges excepted)
  function weaken(nodeIds, factor = 0.6) {
    const t = now();
    db.tx(() => {
      for (const id of nodeIds || []) {
        const rows = db.stmt('SELECT src, dst, type, weight, last_used FROM edge WHERE src = ?1 OR dst = ?1').all(id);
        for (const r of rows) {
          if (STRUCTURAL.has(r.type)) continue;
          db.stmt('UPDATE edge SET weight = ?, last_used = ? WHERE src = ? AND dst = ? AND type = ?')
            .run(clamp(effective(r.weight, r.last_used, r.type, t) * factor), t, r.src, r.dst, r.type);
        }
      }
    });
  }

  // delete edges whose effective weight fell under the floor; works through `limit` source nodes per call
  function prune({ floor = FLOOR, fromSrc = 0, limit = 1e9 } = {}) {
    const t = now();
    const srcs = db.stmt('SELECT DISTINCT src FROM edge WHERE src >= ? ORDER BY src LIMIT ?').all(fromSrc, limit + 1).map(r => r.src);
    const mine = srcs.slice(0, limit);
    let removed = 0;
    db.tx(() => {
      for (const s of mine) for (const r of db.stmt('SELECT dst, type, weight, last_used FROM edge WHERE src = ?').all(s)) {
        if (effective(r.weight, r.last_used, r.type, t) < floor) removed += db.stmt('DELETE FROM edge WHERE src = ? AND dst = ? AND type = ?').run(s, r.dst, r.type).changes;
      }
    });
    return { removed, nextSrc: srcs.length > limit ? srcs[limit] : null };
  }

  return { link, unlink, neighbors, strengthen, weaken, prune, around };
}

module.exports = { createEdges, effective, TYPES, STRUCTURAL, ETA_LINK, ETA_USE, FLOOR };
