// Settings → Memory: the IPC verbs (W1 §6, E3, E11). The renderer never touches the database: every payload is
// checked against a small schema (strings ≤ 2,000, ids positive integers, arrays ≤ 200, no unknown fields) and a
// refused payload writes nothing. Handlers are plain functions so they can be tested without Electron.
const fs = require('node:fs');

const MAX_STR = 2000, MAX_IDS = 200, MAX_IMPORT = 5 * 1024 * 1024;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = v => Number.isSafeInteger(v) && v > 0;
const TYPES = {
  id: isId,
  ids: v => Array.isArray(v) && v.length >= 1 && v.length <= MAX_IDS && v.every(isId),
  str: v => typeof v === 'string' && v.length <= MAX_STR,
  int: v => Number.isSafeInteger(v) && v >= 0,
  bool: v => typeof v === 'boolean',
  status: v => ['active', 'pending', 'rejected'].includes(v),
  tier: v => v === 'profile' || v === 'note',
  forget: v => v === 'FORGET',
  session: v => typeof v === 'string' && /^[\w-]{1,80}$/.test(v),
  yes: v => v === true,
};

// schema: { field: 'type' | 'type?' } → { ok: true, value } | { ok: false, error }
function validate(schema, payload) {
  const p = payload === undefined ? {} : payload;
  if (!isObj(p)) return { ok: false, error: 'bad payload' };
  for (const k of Object.keys(p)) if (!Object.hasOwn(schema, k)) return { ok: false, error: `unknown field: ${k}` };
  for (const [k, spec] of Object.entries(schema)) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    if (p[k] === undefined) { if (optional) continue; return { ok: false, error: `missing field: ${k}` }; }
    if (!TYPES[type](p[k])) return { ok: false, error: `bad field: ${k}` };
  }
  return { ok: true, value: p };
}

const day = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const MEMORY_KINDS = new Set(['fact', 'entity', 'chat']);

function createMemoryHandlers(ctx) {
  const { memory, cortex, chats, sessions } = ctx;
  const guard = (schema, fn) => async payload => {
    const v = validate(schema, payload);
    if (!v.ok) return { ok: false, error: v.error };
    try { return await fn(v.value); } catch (err) { return { ok: false, error: String(err?.message || err) }; }
  };

  // the Sources line (W1 §6, §7)
  function origin(item) {
    const n = cortex.node.get(item.id);
    const top = n?.sources?.[0];
    if (top?.kind === 'import') return `imported · ${day(n.created)}`;
    if (item.sessionId) {
      const s = sessions.load(item.sessionId);
      return s ? `from chat ${s.title}` : 'from a deleted chat';
    }
    return `you said it · ${day(n?.created ?? item.created)}`;
  }
  const withOrigin = items => items.map(i => ({ ...i, origin: origin(i) }));

  function rejected() {
    return cortex.node.list({ kind: 'fact', status: 'archived', limit: 1000 }).filter(n => n.data?.rejected === true)
      .map(n => ({ id: n.id, text: n.text, tier: n.data?.tier || 'note', status: 'rejected', created: n.created, updated: n.updated }));
  }

  const many = (ids, fn) => {
    let done = 0; const errors = [];
    for (const id of ids) { const r = fn(id); if (r.ok) done++; else errors.push(`${id}: ${r.reason}`); }
    return errors.length ? { ok: done > 0, done, error: errors.join('; ') } : { ok: true, done };
  };

  function exportJson() {
    const all = cortex.export();
    const nodes = all.nodes.filter(n => MEMORY_KINDS.has(n.kind));
    const ids = new Set(nodes.map(n => n.id));
    return { version: all.version, exportedAt: all.exportedAt, kind: 'jarvis-memory', nodes,
      edges: all.edges.filter(e => ids.has(e.src) && ids.has(e.dst)), provenance: all.provenance.filter(p => ids.has(p.node_id)) };
  }

  return {
    'memory:list': guard({ status: 'status', query: 'str?', tier: 'tier?', offset: 'int?' }, ({ status, query, tier, offset }) => {
      let items;
      if (status === 'pending') items = memory.pending();
      else if (status === 'rejected') items = rejected();
      else items = memory.active({ query, tier, offset, limit: 200 });
      return { ok: true, items: status === 'rejected' ? items : withOrigin(items), stats: memory.stats() };
    }),
    'memory:edit': guard({ id: 'id', text: 'str?', tier: 'tier?' }, ({ id, text, tier }) => {
      const r = memory.edit(id, { text, tier });
      return r.ok ? { ok: true } : { ok: false, error: r.reason };
    }),
    'memory:delete': guard({ id: 'id' }, ({ id }) => {
      const r = memory.remove(id);
      return r.ok ? { ok: true } : { ok: false, error: r.reason };
    }),
    'memory:approve': guard({ ids: 'ids', text: 'str?' }, ({ ids, text }) => {
      if (text !== undefined && ids.length !== 1) return { ok: false, error: 'text needs exactly one id' };
      return many(ids, id => memory.approve(id, text === undefined ? {} : { text }));
    }),
    'memory:reject': guard({ ids: 'ids' }, ({ ids }) => many(ids, id => memory.reject(id))),
    // the tab's "Forget everything" (E3): facts, entities and chat summaries, tombstones included
    'memory:wipe': guard({ confirm: 'forget' }, () => ({ ok: true, removed: cortex.wipe({ kinds: ['fact', 'entity', 'chat'] }) })),
    'memory:neighbors': guard({ id: 'id' }, ({ id }) => {
      const node = cortex.node.get(id);
      if (!node || !MEMORY_KINDS.has(node.kind)) return { ok: false, error: 'not_found' };
      const neighbors = cortex.neighbors(id, { depth: 1, limit: 30 }).map(n => {
        const o = cortex.node.get(n.id);
        return o && { id: o.id, kind: o.kind, text: o.text, status: o.status, type: n.type, weight: Math.round(n.weight * 100) / 100 };
      }).filter(Boolean);
      return { ok: true, node: { id: node.id, kind: node.kind, text: node.text, status: node.status }, neighbors };
    }),
    'memory:embedder': guard({}, async () => ({ ok: true, ...(await ctx.embedder.status()) })),
    // never pull a model without the user's click AND a native confirm naming it and its size
    'memory:installEmbedder': guard({}, async () => {
      const st = await ctx.embedder.status();
      const yes = await ctx.dialog.confirm(`Download ${st.model || 'nomic-embed-text'} (about 270 MB) from Ollama?`);
      if (!yes) return { ok: false, declined: true };
      return { ok: true, ...(await ctx.embedder.install()) };
    }),
    'memory:export': guard({}, async () => {
      const file = await ctx.dialog.saveFile('jarvis-memory.json');
      if (!file) return { ok: false, cancelled: true };
      const j = exportJson();
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
      return { ok: true, path: file, count: j.nodes.length };
    }),
    // import: only facts, through the same checks as "remember", as pending for the user to approve (E11)
    'memory:import': guard({}, async () => {
      const file = await ctx.dialog.openFile();
      if (!file) return { ok: false, cancelled: true };
      if (fs.statSync(file).size > MAX_IMPORT) return { ok: false, error: 'file is larger than 5 MB' };
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, error: 'not a JSON file' }; }
      const texts = [
        ...(Array.isArray(j?.nodes) ? j.nodes.filter(n => n?.kind === 'fact' && !n?.data?.rejected).map(n => ({ text: n.text, tier: n.data?.tier })) : []),
        ...(Array.isArray(j?.facts) ? j.facts.map(f => ({ text: f?.text })) : []),
      ].filter(f => typeof f.text === 'string').slice(0, 1000);
      let proposed = 0, skipped = 0;
      for (const f of texts) { if (memory.propose({ text: f.text, tier: f.tier === 'profile' ? 'profile' : 'note' }).id) proposed++; else skipped++; }
      return { ok: true, proposed, skipped };
    }),
    'summaries:list': guard({}, () => {
      const nodes = cortex.node.list({ kind: 'chat', status: 'active', limit: 500 });
      return { ok: true, items: nodes.map(n => {
        const sessionId = String(n.key || '').replace(/^chat:/, '');
        return { id: n.id, sessionId, title: n.data?.title || '', text: n.text, updated: n.updated, exists: !!sessions.load(sessionId) };
      }) };
    }),
    'summaries:delete': guard({ sessionId: 'session?', all: 'yes?' }, ({ sessionId, all }) => {
      if (all && sessionId === undefined) return { ok: true, removed: cortex.wipe({ kinds: ['chat'] }) };
      if (sessionId !== undefined && !all) return { ok: chats.remove(sessionId) };
      return { ok: false, error: 'give sessionId or all: true' };
    }),
  };
}

module.exports = { createMemoryHandlers, validate };
