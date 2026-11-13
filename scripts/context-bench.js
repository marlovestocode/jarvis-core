// Context assembler bench: `node scripts/context-bench.js [--json]`. Builds the real assembler and the real live/task/memory providers over FAKES
// (a fake LiveState snapshot, a fake task runner, a fake memory block returning 20 lines), plus one hanging and one throwing provider.
// Reports assemble latency p50/p95 over N runs (healthy, one failing, one hanging), package size, and items dropped by reason.
// Limits: no real Cortex store, no live model, no disk; numbers show the assembler's own overhead and the timeout bound, not retrieval quality.
// Exports run({ runs, timeoutMs, budgetChars }) -> numbers.
const { createAssembler } = require('../src/core/context/assemble.js');
const { liveProvider, taskProvider, memoryProvider } = require('../src/core/context/providers.js');

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const r2 = (n) => Math.round(n * 100) / 100;

function fakes() {
  const live = { snapshot: () => ({ activeWindow: { app: 'Code', title: 'bench.js - jarvis' }, timers: { count: 2, nextInMs: 300000 }, media: { playing: true } }) };
  const tasks = { active: () => ({ id: 't1', title: 'Write the weekly report', status: 'running', done: 2, total: 5 }) };
  const lines = Array.from({ length: 20 }, (_, i) => `- Remembered fact number ${i} about the owner preferences and past projects, kept short [semantic]`);
  const block = { forTurn: async () => ({ memo: ['Relevant memory:', ...lines].join('\n'), ids: lines.map((_, i) => `n${i}`) }) };
  return { live, tasks, block };
}

// extra items that exercise the drop reasons (stale, superseded, duplicate, access, invalid)
function mixedProvider(now) {
  const base = { source: 'bench', trust: 'owner', sensitivity: 'personal', confidence: 0.8 };
  return { name: 'mixed', fetch: () => [
    { ...base, id: 'x:stale', kind: 'state', text: 'Active window: Old', observedAt: now() - 600000 },
    { ...base, id: 'x:old', kind: 'task', text: 'Task is paused', observedAt: now() - 500000, topic: 'bench-topic' },
    { ...base, id: 'x:new', kind: 'task', text: 'Task is running', observedAt: now() - 1000, topic: 'bench-topic' },
    { ...base, id: 'x:dup1', kind: 'memory', text: 'Same line twice', observedAt: null },
    { ...base, id: 'x:dup2', kind: 'memory', text: 'same  line twice', observedAt: null },
    { ...base, id: 'x:priv', kind: 'memory', text: 'Private note', observedAt: null, sensitivity: 'private' },
    { id: 'x:bad', text: 5 },
  ] };
}

async function time(asm, runs, req) {
  const ms = []; let errors = 0, maxChars = 0, last;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    last = await asm.assemble(req);
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
    errors += last.errors.length; maxChars = Math.max(maxChars, last.text.length);
  }
  return { p50: r2(pct(ms, 0.5)), p95: r2(pct(ms, 0.95)), errors, maxChars, chars: last.text.length, items: last.items.length };
}

async function run({ runs = 200, timeoutMs = 40, budgetChars = 800 } = {}) {
  const f = fakes();
  const healthy = [liveProvider({ live: f.live }), taskProvider({ tasks: f.tasks }), memoryProvider({ block: f.block })];
  const throwing = { name: 'throws', fetch() { throw new Error('boom'); } };
  const hanging = { name: 'hangs', fetch: () => new Promise(() => {}) };
  const req = { text: 'what am I working on', speaker: 'owner', sessionId: 's1' };
  const mk = (providers) => createAssembler({ providers, budgetChars, timeoutMs });
  const h = await time(mk(healthy), runs, req);
  const fl = await time(mk([...healthy, throwing]), runs, req);
  const hg = await time(mk([...healthy, hanging]), runs, req);
  const pkg = await createAssembler({ providers: [...healthy, mixedProvider(Date.now)], budgetChars, timeoutMs }).assemble(req);
  const dropped = {};
  for (const d of pkg.dropped) dropped[d.reason] = (dropped[d.reason] || 0) + 1;
  return {
    runs, timeoutMs, budgetChars, healthy: h, failing: fl, hanging: hg,
    maxChars: Math.max(h.maxChars, fl.maxChars, hg.maxChars, pkg.text.length), packageChars: pkg.text.length, packageItems: pkg.items.length, hintChars: pkg.hint.length, dropped,
  };
}

module.exports = { run };

if (require.main === module) {
  run().then((r) => {
    if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); return; }
    const row = (n, x) => `  ${n.padEnd(8)} p50 ${x.p50} ms  p95 ${x.p95} ms  errors ${x.errors}  max chars ${x.maxChars}`;
    console.log(`context bench (fakes; ${r.runs} runs; timeoutMs ${r.timeoutMs}; budget ${r.budgetChars})`);
    console.log(row('healthy', r.healthy)); console.log(row('failing', r.failing)); console.log(row('hanging', r.hanging));
    console.log(`  package ${r.packageChars} chars, ${r.packageItems} items, hint ${r.hintChars} chars; max over all runs ${r.maxChars}`);
    console.log(`  dropped by reason: ${JSON.stringify(r.dropped)}`);
  });
}
