// Turns raw metric events into what the dashboard (and "how have you been doing?") shows. Pure: events in, numbers out.
// Event kinds (see collector.js): turn, tool, route, clarify, ytprompt, err, warn, sample, conn.
// summarize(events, { from, to, bucketMs, group, tool, source }) → { range, totals, series, tools, groups, connections, memory, filters }
// Filters: group (skill group id) and tool narrow the tool rows and tool series; source ('voice' | 'text') narrows turns.

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const round = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const avg = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

const SERVICES = ['ollama', 'ytmusic', 'wallpaper', 'speechHost', 'mediaHost', 'pcHost'];

// a bucket size that gives 24 to 120 points for the range
function autoBucket(span) {
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 864e5];
  return steps.find(s => span / s <= 120) || 864e5;
}

function summarize(events, { from, to, bucketMs, group = null, tool = null, source = null } = {}) {
  const end = Number.isFinite(to) ? to : Date.now();
  const start = Number.isFinite(from) ? from : end - 864e5;
  const bucket = bucketMs > 0 ? bucketMs : autoBucket(end - start);
  const n = Math.max(1, Math.ceil((end - start) / bucket));
  const zeros = () => new Array(n).fill(0);
  const at = t => Math.min(n - 1, Math.max(0, Math.floor((t - start) / bucket)));
  const evs = events.filter(e => e.t >= start && e.t <= end);

  const series = { t: Array.from({ length: n }, (_, i) => start + i * bucket), turns: zeros(), toolCalls: zeros(), toolFails: zeros(), errors: zeros(), voice: zeros(), text: zeros() };
  const lat = Array.from({ length: n }, () => []);
  const totals = { turns: 0, byTier: {}, bySource: { voice: 0, text: 0 }, promptTokens: 0, completionTokens: 0, toolCalls: 0, toolOk: 0, toolFail: 0, softFails: 0, badArgs: 0,
    errors: 0, warnings: 0, clarify: { ask: 0, decline: 0 }, prompts: { confirmed: 0, skipped: 0 }, fastPath: 0 };
  const turnMs = [], tps = [];
  const toolRows = new Map();
  const groupsSeen = new Set(), toolsSeen = new Set(), sourcesSeen = new Set();
  const conn = new Map(), mem = [], drops = new Map(), ups = new Map();

  for (const e of evs) {
    if (e.k === 'turn') {
      if (e.source) sourcesSeen.add(e.source);
      if (source && e.source !== source) continue;
      totals.turns++; totals.byTier[e.tier || 'unknown'] = (totals.byTier[e.tier || 'unknown'] || 0) + 1;
      if (e.source === 'voice' || e.source === 'text') { totals.bySource[e.source]++; series[e.source][at(e.t)]++; }
      totals.promptTokens += e.promptTokens || 0; totals.completionTokens += e.completionTokens || 0;
      series.turns[at(e.t)]++;
      if (Number.isFinite(e.ms)) { turnMs.push(e.ms); lat[at(e.t)].push(e.ms); }
      if (Number.isFinite(e.tps)) tps.push(e.tps);
    } else if (e.k === 'tool') {
      if (e.group) groupsSeen.add(e.group);
      if (e.name) toolsSeen.add(e.name);
      if (group && e.group !== group) continue;
      if (tool && e.name !== tool) continue;
      totals.toolCalls++; series.toolCalls[at(e.t)]++;
      const row = toolRows.get(e.name) || { name: e.name, group: e.group || null, calls: 0, ok: 0, fail: 0, soft: 0, badArgs: 0, ms: [] };
      row.calls++;
      if (e.ok) { row.ok++; totals.toolOk++; } else { row.fail++; totals.toolFail++; series.toolFails[at(e.t)]++; }
      if (e.soft) { row.soft++; totals.softFails++; }
      if (e.bad) { row.badArgs++; totals.badArgs++; }
      if (Number.isFinite(e.ms)) row.ms.push(e.ms);
      toolRows.set(e.name, row);
    } else if (e.k === 'route' && e.tier === 'skill') totals.fastPath++;
    else if (e.k === 'clarify') { if (e.kind === 'ask' || e.kind === 'decline') totals.clarify[e.kind]++; }
    else if (e.k === 'ytprompt') { if (e.confirmed) totals.prompts.confirmed++; else totals.prompts.skipped++; }
    else if (e.k === 'err') { totals.errors++; series.errors[at(e.t)]++; }
    else if (e.k === 'warn') totals.warnings++;
    else if (e.k === 'conn' && e.service) { const m = e.up ? ups : drops; m.set(e.service, (m.get(e.service) || 0) + 1); }
    else if (e.k === 'sample') {
      mem.push(e);
      for (const s of SERVICES) if (e.svc && s in e.svc) { const c = conn.get(s) || { up: 0, total: 0 }; c.total++; if (e.svc[s]) c.up++; conn.set(s, c); }
    }
  }

  const sortedMs = [...turnMs].sort((a, b) => a - b);
  const latency = { p50: lat.map(l => round(pct([...l].sort((a, b) => a - b), 0.5))), p95: lat.map(l => round(pct([...l].sort((a, b) => a - b), 0.95))) };
  const tools = [...toolRows.values()].map(r => {
    const ms = r.ms.sort((a, b) => a - b);
    return { name: r.name, group: r.group, calls: r.calls, ok: r.ok, fail: r.fail, soft: r.soft, badArgs: r.badArgs, successRate: round(r.ok / r.calls * 100, 1), avgMs: round(avg(ms)), p95Ms: round(pct(ms, 0.95)) };
  }).sort((a, b) => b.calls - a.calls);
  const groups = new Map();
  for (const r of tools) { const g = groups.get(r.group || 'other') || { id: r.group || 'other', calls: 0, ok: 0 }; g.calls += r.calls; g.ok += r.ok; groups.set(g.id, g); }

  const connections = {};
  for (const [s, c] of conn) connections[s] = { upPct: round(c.up / c.total * 100, 1), samples: c.total, drops: drops.get(s) || 0, reconnects: ups.get(s) || 0 };
  mem.sort((a, b) => a.t - b.t);
  const first = mem[0], last = mem.at(-1);
  const days = first && last && last.t > first.t ? (last.t - first.t) / 864e5 : 0;
  const grow = key => (days >= 0.02 && Number.isFinite(first?.[key]) && Number.isFinite(last?.[key]) ? round((last[key] - first[key]) / days, 1) : null);

  return {
    range: { from: start, to: end, bucketMs: bucket },
    totals: {
      ...totals, avgTurnMs: round(avg(turnMs)), p50TurnMs: round(pct(sortedMs, 0.5)), p95TurnMs: round(pct(sortedMs, 0.95)), avgTps: round(avg(tps), 1),
      toolSuccessRate: totals.toolCalls ? round(totals.toolOk / totals.toolCalls * 100, 1) : null,
    },
    series: { ...series, latencyP50: latency.p50, latencyP95: latency.p95 },
    tools, groups: [...groups.values()].map(g => ({ ...g, successRate: round(g.ok / g.calls * 100, 1) })).sort((a, b) => b.calls - a.calls),
    connections,
    memory: {
      t: mem.map(m => m.t), rssMB: mem.map(m => m.rssMB ?? null), heapMB: mem.map(m => m.heapMB ?? null), cortexNodes: mem.map(m => m.cortexNodes ?? null), cortexBytes: mem.map(m => m.cortexBytes ?? null), plays: mem.map(m => m.plays ?? null),
      latest: last ? { rssMB: last.rssMB ?? null, heapMB: last.heapMB ?? null, cortexNodes: last.cortexNodes ?? null, cortexBytes: last.cortexBytes ?? null, plays: last.plays ?? null } : null,
      growthPerDay: { rssMB: grow('rssMB'), cortexBytes: grow('cortexBytes'), cortexNodes: grow('cortexNodes') },
    },
    filters: { groups: [...groupsSeen].sort(), tools: [...toolsSeen].sort(), sources: [...sourcesSeen].sort(), services: SERVICES },
  };
}

// a short spoken-style summary of the last day or so, for "how have you been doing?"
function describe(s) {
  const t = s.totals;
  if (!t.turns && !t.toolCalls) return 'Nothing recorded in that period yet.';
  const parts = [`${t.turns} ${t.turns === 1 ? 'conversation turn' : 'conversation turns'}`];
  if (t.p50TurnMs !== null) parts.push(`typical reply time ${(t.p50TurnMs / 1000).toFixed(1)} seconds`);
  if (t.toolCalls) parts.push(`${t.toolCalls} skill calls, ${t.toolSuccessRate}% succeeded`);
  if (t.errors) parts.push(`${t.errors} ${t.errors === 1 ? 'error' : 'errors'}`);
  if (t.clarify.ask + t.clarify.decline) parts.push(`${t.clarify.ask} questions asked instead of guessing, ${t.clarify.decline} requests declined`);
  if (t.prompts.confirmed) parts.push(`${t.prompts.confirmed} YouTube prompts confirmed`);
  const worst = s.tools.filter(r => r.calls >= 3).sort((a, b) => a.successRate - b.successRate)[0];
  if (worst && worst.successRate < 90) parts.push(`weakest skill: ${worst.name} at ${worst.successRate}%`);
  const down = Object.entries(s.connections).filter(([, c]) => c.upPct < 95).map(([k, c]) => `${k} ${c.upPct}%`);
  if (down.length) parts.push(`connection uptime below 95% for ${down.join(', ')}`);
  return parts.join('; ') + '.';
}

module.exports = { summarize, describe, autoBucket, SERVICES };
