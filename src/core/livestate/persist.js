// Persisted LiveState: <dir>/livestate.json, so "again" and the failure cooldown survive a restart.
//
// METADATA ONLY. save() copies an explicit whitelist of fields (tool {name,ok,soft,t}, model-fail {name,t}, route,
// turn ms, voice state) and drops everything else, so tool args, output, replies, window titles and any other
// text can never reach the file even if a caller passes them. The active window is not persisted at all.
//
// load() never throws: a missing, unreadable, corrupt or non-object file, or one older than 24 h, is null.
// save() never throws, is debounced per directory (the last snapshot wins), and writes atomically
// (temp file then rename). flush() writes whatever is pending now (shutdown).
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'livestate.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const MAX_ITEMS = 12;
const MAX_STR = 80;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.slice(0, MAX_STR) : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// the one place that decides what may be written
function sanitize(s) {
  if (!isObj(s)) return null;
  const t = num(s.t);
  if (t === null) return null;
  const tools = (Array.isArray(s.tools) ? s.tools : []).filter(x => isObj(x) && num(x.t) !== null)
    .slice(-MAX_ITEMS).map(x => ({ name: str(x.name) ?? '', ok: x.ok === true, soft: x.soft === true, t: x.t }));
  const models = (Array.isArray(s.models) ? s.models : []).filter(x => isObj(x) && typeof x.name === 'string' && num(x.t) !== null)
    .slice(-MAX_ITEMS).map(x => ({ name: str(x.name), t: x.t }));
  return {
    t,
    voice: str(s.voice),
    tools,
    models,
    route: isObj(s.route) ? { tier: str(s.route.tier), model: str(s.route.model), reason: str(s.route.reason) } : null,
    turn: isObj(s.turn) ? { ms: num(s.turn.ms) } : null,
  };
}

function load(dir, { now = Date.now } = {}) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    const clean = sanitize(v);
    if (!clean) return null;
    const age = now() - clean.t;
    if (!(age <= MAX_AGE_MS)) return null;
    return clean;
  } catch { return null; }
}

function write(dir, snap) {
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

const pending = new Map(); // dir -> { snap, timer }

function flush() {
  for (const [dir, p] of [...pending]) {
    pending.delete(dir);
    clearTimeout(p.timer);
    write(dir, p.snap);
  }
}

function save(dir, snapshot, { delayMs = DEBOUNCE_MS } = {}) {
  try {
    const snap = sanitize(snapshot);
    if (!snap || typeof dir !== 'string' || !dir) return;
    const prev = pending.get(dir);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      pending.delete(dir);
      write(dir, snap);
    }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(dir, { snap, timer });
  } catch { /* persistence is best effort */ }
}

module.exports = { load, save, flush, sanitize, FILE, MAX_AGE_MS };
