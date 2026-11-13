// What to do when the model calls a tool that does not exist. A small model keeps doing it: it calls a skill group's name
// as if it were a tool ("ytmusic", "memory"), or continues a naming pattern ("ytm_pause" next to ytm_library), and an error
// that only lists the valid names does not get it back on track. So the runner tries, in order:
//   1. a name it has made up before that has an obvious real meaning (the tool lists those itself, as `mistakes`) → run the real tool with the right arguments
//   2. a skill group's name → load that group and say which tools it has now
//   3. otherwise an error that suggests the closest real tools
// Everything here is pure; registry.js decides what to run.

const GENERIC = new Set(['get', 'set', 'list', 'the', 'tool', 'tools', 'all', 'show', 'open']);   // words that start many tool names say nothing about which one is meant
const norm = s => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_?(?:skills?|group|tool)$/, '');

function distance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// up to three real tool names that look like the invented one: similar spelling, or sharing a word of the name
function closest(name, names) {
  const want = norm(name), words = want.split('_').filter(w => w.length > 2 && !GENERIC.has(w));
  const scored = [];
  for (const n of names) {
    const sim = 1 - distance(want, n) / Math.max(want.length, n.length);
    const shared = n.split('_').filter(w => words.includes(w)).length;
    const score = sim + shared * 0.25;
    if (sim >= 0.65 || shared >= 1) scored.push({ n, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.n.localeCompare(b.n)).slice(0, 3).map(x => x.n);
}

// tools: the real tool objects (a tool may list `mistakes: [{ match: RegExp, args?: m => ({...}) }]`); groups: [{ id, label }] (may be empty)
// → { tool, args } | { group } | null
function resolveInvented(name, tools, groups = []) {
  const key = norm(name);
  if (!key) return null;
  for (const t of tools) {
    for (const mk of t.mistakes || []) {
      const m = mk.match.exec(key);
      if (m) return { tool: t.name, args: mk.args ? mk.args(m) : {} };
    }
  }
  const g = groups.find(x => norm(x.id) === key || norm(x.label) === key);
  if (g) return { group: g.id };
  return null;
}

module.exports = { resolveInvented, closest, distance };
