// LiveState: a tiny in-memory picture of "what is happening right now".
//
// Contract:
//  - Fed by the bus (voice state, route, finished tools, last turn timing)
//    and by pull sources registered with register(name, fn).
//  - Holds only metadata. Tool args and output text are never stored: a tool
//    entry is { name, ok, soft, t } and nothing else. A model-failure entry
//    is { name, t } and nothing else.
//  - Tool ring is bounded (MAX_TOOLS) and entries expire after TOOL_TTL_MS.
//  - snapshot() is synchronous, returns a fresh plain object each call and
//    never throws; a failing source is skipped (logged once per source).
const TOOL_TTL_MS = 10 * 60 * 1000;
const MAX_TOOLS = 8;
const MAX_MODELS = 6;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function createLiveState({ bus, now = Date.now, log = () => {} } = {}) {
  let voice = null;
  let route = null;
  let turn = null;
  let tools = [];
  let models = [];
  const sources = new Map(); // name -> fn
  const warned = new Set();

  function prune(t) {
    tools = tools.filter((x) => t - x.t <= TOOL_TTL_MS);
    if (tools.length > MAX_TOOLS) tools = tools.slice(tools.length - MAX_TOOLS);
    models = models.filter((x) => t - x.t <= TOOL_TTL_MS);
    if (models.length > MAX_MODELS) models = models.slice(models.length - MAX_MODELS);
  }

  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'state':
        voice = typeof ev.state === 'string' ? ev.state : null;
        break;
      case 'route':
        route = { tier: ev.tier ?? null, model: ev.model ?? null, reason: ev.reason ?? null };
        break;
      case 'turn':
        turn = { ms: typeof ev.ms === 'number' ? ev.ms : null };
        break;
      case 'tool': {
        if (ev.phase !== 'end') break;
        const t = now();
        tools.push({ name: typeof ev.name === 'string' ? ev.name : '', ok: ev.ok === true, soft: ev.soft === true, t });
        prune(t);
        break;
      }
      case 'modelfail': {
        if (typeof ev.model !== 'string' || !ev.model) break;
        const t = now();
        models.push({ name: ev.model, t });
        prune(t);
        break;
      }
      default:
    }
  }

  const unsub = bus && typeof bus.on === 'function' ? bus.on('*', onEvent) : () => {};

  function register(name, fn) {
    if (typeof name === 'string' && typeof fn === 'function') sources.set(name, fn);
  }

  function snapshot() {
    const t = now();
    prune(t);
    const snap = {
      t,
      voice,
      tools: tools.map((x) => ({ ...x })),
      route: route ? { ...route } : null,
      turn: turn ? { ...turn } : null,
      models: models.map((x) => ({ ...x })),
    };
    for (const [name, fn] of sources) {
      try {
        const v = fn();
        if (isPlainObject(v)) snap[name] = v;
      } catch (err) {
        if (!warned.has(name)) {
          warned.add(name);
          try { log(`livestate source "${name}" failed: ${err && err.message}`); } catch {}
        }
      }
    }
    return snap;
  }

  function close() {
    try { unsub(); } catch {}
  }

  return { register, snapshot, close };
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

// The "Right now" prompt block. Media is left out on purpose: mediaPromptLine already renders it.
function liveLine(snap, { max = 5 } = {}) {
  if (!isPlainObject(snap)) return '';
  const items = [];
  if (typeof snap.voice === 'string' && snap.voice && !['idle', 'thinking', 'error'].includes(snap.voice)) items.push(`voice: ${snap.voice}`);
  const tm = snap.timers;
  if (isPlainObject(tm) && tm.count > 0) {
    let s = `${tm.count} timer${tm.count === 1 ? '' : 's'}`;
    if (typeof tm.nextInMs === 'number') s += `, next in ${fmtDur(tm.nextInMs)}`;
    items.push(s);
  }
  if (isPlainObject(snap.confirm) && snap.confirm.summary) items.push(`waiting for the user to confirm: ${snap.confirm.summary}`);
  if (Array.isArray(snap.tools) && snap.tools.length && max > 0) {
    const last = snap.tools.slice(-max).map((x) => `${x.name} ${x.ok ? 'ok' : 'failed'}`);
    items.push(`last actions: ${last.join(', ')}`);
  }
  if (!items.length) return '';
  return ['Right now:', ...items.map((i) => `- ${i}`)].join('\n');
}

module.exports = { createLiveState, liveLine, TOOL_TTL_MS, MAX_TOOLS, MAX_MODELS };
