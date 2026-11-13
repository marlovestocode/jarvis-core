// LiveState: a tiny in-memory picture of "what is happening right now".
//
// Contract:
//  - Fed by the bus (voice state, route, finished tools, last turn timing)
//    and by pull sources registered with register(name, fn).
//  - Holds only metadata. Tool args and output text are never stored: a tool
//    entry is { name, ok, soft, t } and nothing else; tool end events with
//    badArgs or skipped set are not stored. A model-failure entry
//    is { name, t } and nothing else.
//  - Tool ring is bounded (MAX_TOOLS) and entries expire after TOOL_TTL_MS.
//  - Optional restore (a snapshot loaded from disk) seeds tools, models, route and turn on boot, re-pruned by the
//    same TTLs; optional save(meta) is called after each state change with the metadata-only picture. Both are
//    best effort: a throwing hook or a malformed restore is ignored.
//  - snapshot() is synchronous, returns a fresh plain object each call and
//    never throws; a failing source is skipped (logged once per source).
const TOOL_TTL_MS = 10 * 60 * 1000;
const MAX_TOOLS = 8;
const MAX_MODELS = 6;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function createLiveState({ bus, now = Date.now, log = () => {}, restore = null, save = null } = {}) {
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

  function meta(t) {
    return { t, voice, tools: tools.map((x) => ({ ...x })), models: models.map((x) => ({ ...x })), route: route ? { ...route } : null, turn: turn ? { ...turn } : null };
  }

  function persistNow() {
    if (typeof save !== 'function') return;
    try { save(meta(now())); } catch { /* persistence is best effort */ }
  }

  // metadata only, rebuilt field by field; the old voice state is not restored (nothing is speaking after a restart)
  function restoreFrom(r) {
    if (!isPlainObject(r)) return;
    const t = now();
    const okT = (x) => isPlainObject(x) && typeof x.t === 'number' && Number.isFinite(x.t) && x.t <= t;
    if (Array.isArray(r.tools)) tools = r.tools.filter(okT).map((x) => ({ name: typeof x.name === 'string' ? x.name : '', ok: x.ok === true, soft: x.soft === true, t: x.t }));
    if (Array.isArray(r.models)) models = r.models.filter((x) => okT(x) && typeof x.name === 'string' && x.name).map((x) => ({ name: x.name, t: x.t }));
    if (isPlainObject(r.route)) route = { tier: r.route.tier ?? null, model: r.route.model ?? null, reason: r.route.reason ?? null };
    if (isPlainObject(r.turn)) turn = { ms: typeof r.turn.ms === 'number' ? r.turn.ms : null };
    prune(t);
  }
  try { restoreFrom(restore); } catch { tools = []; models = []; }

  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    onEventInner(ev);
    if (['state', 'route', 'turn', 'tool', 'modelfail'].includes(ev.type)) persistNow();
  }

  function onEventInner(ev) {
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
        // a schema-rejected call or a synthetic result (the tool never ran) is the model's mistake, not the tool's health
        if (ev.badArgs || ev.skipped) break;
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
