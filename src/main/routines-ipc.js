'use strict';
// Settings → Routines: the renderer lists, saves and removes saved routines. The store validates every routine;
// nothing here runs one (a routine runs by voice or chat, through the fast path).
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function createRoutineHandlers(ctx) {
  const store = () => ctx.routineStore;
  return {
    'routines:list': async () => store().list().map(r => ({ name: r.name, steps: r.steps })),
    'routines:save': async routine => {
      if (!isObj(routine)) return { ok: false, error: 'Send a routine: { name, steps }.' };
      try { return store().save(routine); } catch (err) { return { ok: false, error: String(err?.message || err) }; }
    },
    'routines:remove': async name => (typeof name === 'string' ? !!store().remove(name) : false),
  };
}

module.exports = { createRoutineHandlers };
