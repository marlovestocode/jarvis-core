// Failure cooldown for tools and models. Pure: reads a LiveState snapshot and
// returns the names that failed recently enough to be avoided for a short while.
const COOLDOWN_MS = 120000;
const COOL_AT = 2;

function empty() {
  return { tools: new Set(), models: new Set() };
}

// Sums weighted failures per name within the window. `weigh` returns 0 for entries that do not count.
function tally(entries, now, weigh) {
  const sums = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.name !== 'string' || !Number.isFinite(e.t)) continue;
    if (now - e.t > COOLDOWN_MS) continue;
    const w = weigh(e);
    if (w > 0) sums.set(e.name, (sums.get(e.name) || 0) + w);
  }
  const out = new Set();
  for (const [name, sum] of sums) if (sum >= COOL_AT) out.add(name);
  return out;
}

function cooling(snap, now = Date.now()) {
  try {
    if (!snap || typeof snap !== 'object') return empty();
    const out = empty();
    if (Array.isArray(snap.tools)) {
      out.tools = tally(snap.tools, now, e => (e.soft === true ? 0.5 : e.ok === false ? 1 : 0));
    }
    if (Array.isArray(snap.models)) {
      out.models = tally(snap.models, now, () => 1);
    }
    return out;
  } catch {
    return empty();
  }
}

module.exports = { cooling, COOLDOWN_MS, COOL_AT };
