// Watches the event bus and writes what JARVIS does to the local metrics store. Reads only facts that are already events
// (a turn finished, a tool ran, a prompt was confirmed); it stores names, counts, timings and sizes, never what was said.
// Every 60 s it also takes one sample of the parts that have no events: process memory, memory-store size, and whether each
// connection is up (the share of samples that are up is the dashboard's uptime).
//   createMetrics({ dir, bus, groupOf(toolName), sample() → { svc, cortexNodes, ... }, usage() }) → { add, query, summary, flush, close, start, stop, stats }
const { createStore } = require('./store');
const { summarize, describe } = require('./aggregate');

const SAMPLE_MS = 60000;
const MAX_OPEN_TOOLS = 200;

function createMetrics({ dir, bus = null, now = Date.now, groupOf = () => null, sample = () => ({}), usage = () => process.memoryUsage(), sampleMs = SAMPLE_MS, flushMs, maxDays, log = () => {} } = {}) {
  const store = createStore({ dir, now, flushMs, maxDays, log });
  const open = new Map();   // tool call id → start time (a call that never ends is dropped when the map grows)
  let timer = null;
  const offs = [];

  const add = ev => { try { store.add({ t: now(), ...ev }); } catch (err) { log('metrics: ' + err.message); } };

  function onTool(ev) {
    if (ev.phase === 'start') {
      open.set(ev.id, now());
      if (open.size > MAX_OPEN_TOOLS) open.delete(open.keys().next().value);
      return;
    }
    if (ev.phase !== 'end') return;
    const t0 = open.get(ev.id);
    open.delete(ev.id);
    add({ k: 'tool', name: String(ev.name || 'unknown'), group: groupOf(ev.name) || null, ok: ev.ok !== false, ms: t0 === undefined ? null : now() - t0, soft: ev.soft ? 1 : undefined, bad: ev.badArgs ? 1 : undefined });
  }

  function takeSample() {
    try {
      const u = usage();
      const extra = sample() || {};
      add({ k: 'sample', rssMB: Math.round(u.rss / 1048576), heapMB: Math.round(u.heapUsed / 1048576), ...extra });
    } catch (err) { log('metrics sample: ' + err.message); }
  }

  if (bus) {
    offs.push(bus.on('turn', e => add({ k: 'turn', source: e.source || null, tier: e.tier || null, model: e.model || null, think: e.think ? 1 : 0, ms: e.ms, tps: e.tps ?? undefined, promptTokens: e.promptTokens || 0, completionTokens: e.completionTokens || 0, toolRounds: e.toolRounds || 0 })));
    let lastProvider = null;   // the provider event comes every turn: only a change of ready/not ready is a connection event
    offs.push(bus.on('provider', e => { if (e.id !== 'ollama' || lastProvider === !!e.ready) return; lastProvider = !!e.ready; add({ k: 'conn', service: 'ollama', up: !!e.ready }); }));
    offs.push(bus.on('tool', onTool));
    offs.push(bus.on('route', e => add({ k: 'route', tier: e.tier || null, reason: e.reason || null })));
    offs.push(bus.on('clarify', e => add({ k: 'clarify', kind: e.kind, reason: e.reason })));
    offs.push(bus.on('ytprompt', e => add({ k: 'ytprompt', kind: e.kind, confirmed: !!e.confirmed })));
    offs.push(bus.on('state', e => { if (e.state === 'error') add({ k: 'err', where: 'turn', detail: String(e.detail || '').slice(0, 80) }); }));
    offs.push(bus.on('log', e => { if (e.level === 'warn' || e.level === 'error') add({ k: 'warn', text: String(e.text || '').slice(0, 80) }); }));
  }

  function start() { if (!timer) { timer = setInterval(takeSample, sampleMs); timer.unref?.(); takeSample(); } }
  function stop() { clearInterval(timer); timer = null; }
  function close() { stop(); for (const off of offs.splice(0)) { try { off(); } catch { /* bus gone */ } } store.close(); }

  // opts: { from, to, bucketMs, group, tool, source }; range defaults to the last 24 hours
  function query(opts = {}) {
    const to = Number.isFinite(opts.to) ? opts.to : now();
    const from = Number.isFinite(opts.from) ? opts.from : to - 864e5;
    return summarize(store.read(from, to), { ...opts, from, to });
  }

  return { add, query, summary: opts => describe(query(opts)), flush: () => store.flush(), close, start, stop, sampleNow: takeSample, stats: () => ({ ...store.stats(), openTools: open.size }) };
}

module.exports = { createMetrics, SAMPLE_MS };
