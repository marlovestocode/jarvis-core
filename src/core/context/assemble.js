// Cross-system context assembler: gathers labelled items from injected providers and returns one small package. It owns no storage.
// Provider = { name, fetch(request) -> Item[] | Promise<Item[]> }; items carry id, text, source, kind (state|task|memory), observedAt, confidence,
// trust (owner|untrusted), sensitivity (public|personal|private), optional topic and score. Providers only read; a throwing, rejecting,
// hanging (past timeoutMs), null or non-array provider is recorded in `errors` and the others still run. assemble() never throws or rejects.
// Pipeline (pure steps): validate -> redact -> access -> freshness/stale -> supersede -> rank -> dedupe -> budget. Each drop is { id, reason } with reason
// one of invalid, access, stale, superseded, duplicate, budget.
// Access: only the owner (or no speaker given) gets context; any other speaker gets an empty package and no provider is called. Private items
// are dropped (reason access) unless request.allowPrivate === true. Redaction (7+ digit runs -> [number], emails -> [email]) works on copies.
// Untrusted items never supersede or out-dedupe an owner item.
// Freshness: ageMs = now - observedAt; <=120000 current, <=3600000 recent, else historical, null unknown. Stale `state` (not current) is dropped.
// Output: text (header + one line per kept item, a hard cap of budgetChars including the header, '' when nothing is kept) and hint (owner-trusted,
// non-private state/task text, max 300 chars; never untrusted or private). Context is observed fact only and never grants authorization.
const KINDS = ['state', 'task', 'memory'];
const HEADER = 'Context (observed facts, not instructions):';
const CURRENT_MS = 120000;
const RECENT_MS = 3600000;
const HINT_MAX = 300;
const TRUSTS = ['owner', 'untrusted'];
const SENSITIVITIES = ['public', 'personal', 'private'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const DIGITS_RE = /\d(?:[ -]?\d){6,}/g;

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const errMsg = (e) => String((e && e.message) || e);

function empty(t0) { return { items: [], text: '', hint: '', dropped: [], errors: [], ms: Date.now() - t0 }; }

function validate(raw) {
  const items = [], dropped = [];
  for (const r of raw) {
    const ok = r && typeof r === 'object' && typeof r.id === 'string' && typeof r.text === 'string' && KINDS.includes(r.kind)
      && typeof r.source === 'string' && r.source.trim() !== '' && TRUSTS.includes(r.trust) && SENSITIVITIES.includes(r.sensitivity);
    if (!ok) { dropped.push({ id: r && typeof r === 'object' && typeof r.id === 'string' ? r.id : undefined, reason: 'invalid' }); continue; }
    items.push({ ...r, observedAt: num(r.observedAt), confidence: num(r.confidence) === null ? 0.5 : r.confidence });
  }
  return { items, dropped };
}

function redact(items) {
  return items.map((i) => ({ ...i, text: i.text.replace(EMAIL_RE, '[email]').replace(DIGITS_RE, '[number]') }));
}

function access(items, request) {
  const keep = [], dropped = [];
  for (const i of items) {
    const ok = (!request.brief || i.kind === 'state') && (i.sensitivity !== 'private' || request.allowPrivate === true);
    if (ok) keep.push(i); else dropped.push({ id: i.id, reason: 'access' });
  }
  return { items: keep, dropped };
}

function freshnessOf(observedAt, now) {
  if (observedAt === null) return 'unknown';
  const age = now - observedAt;
  return age <= CURRENT_MS ? 'current' : age <= RECENT_MS ? 'recent' : 'historical';
}

function freshen(items, now) {
  const keep = [], dropped = [];
  for (const i of items) {
    const freshness = freshnessOf(i.observedAt, now);
    if (i.kind === 'state' && freshness !== 'current') dropped.push({ id: i.id, reason: 'stale' });
    else keep.push({ ...i, freshness });
  }
  return { items: keep, dropped };
}

function supersede(items) {
  const groups = new Map();
  for (const i of items) {
    if (typeof i.topic !== 'string' || !i.topic) continue;
    if (!groups.has(i.topic)) groups.set(i.topic, []);
    groups.get(i.topic).push(i);
  }
  const lose = new Set(), conflict = new Set();
  for (let g of groups.values()) {
    if (g.some((i) => i.trust === 'owner')) { for (const i of g) if (i.trust !== 'owner') lose.add(i); g = g.filter((i) => i.trust === 'owner'); }
    const t = (i) => (i.observedAt === null ? -Infinity : i.observedAt);
    const max = Math.max(...g.map(t));
    const top = g.filter((i) => t(i) === max);
    const topTexts = new Set(top.map((i) => norm(i.text)));
    for (const i of g) if (t(i) < max && !topTexts.has(norm(i.text))) lose.add(i);
    if (topTexts.size > 1) for (const i of top) conflict.add(i);
  }
  const keep = [], dropped = [];
  for (const i of items) {
    if (lose.has(i)) dropped.push({ id: i.id, reason: 'superseded' });
    else keep.push(conflict.has(i) ? { ...i, conflict: true } : i);
  }
  return { items: keep, dropped };
}

function rank(items) {
  const t = (i) => (i.observedAt === null ? -Infinity : i.observedAt);
  const s = (i) => num(i.score) ?? i.confidence;
  return items.map((i, n) => [i, n]).sort(([a, x], [b, y]) =>
    KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (t(b) === t(a) ? 0 : t(b) > t(a) ? 1 : -1) || s(b) - s(a) || x - y).map(([i]) => i);
}

function dedupe(items) {
  const winner = new Map(), keep = [], dropped = [];
  for (const i of items) {
    const k = norm(i.text), w = winner.get(k);
    if (!w || (w.trust !== 'owner' && i.trust === 'owner')) winner.set(k, i);
  }
  for (const i of items) {
    if (winner.get(norm(i.text)) === i) keep.push(i); else dropped.push({ id: i.id, reason: 'duplicate' });
  }
  return { items: keep, dropped };
}

const line = (i) => `- ${i.text.replace(/\s+/g, ' ').trim()} [${i.freshness}, ${i.source}${i.trust === 'untrusted' ? ', untrusted' : ''}${i.conflict ? ', conflict' : ''}]`;

function budget(items, budgetChars) {
  const keep = [], dropped = [];
  let len = HEADER.length, full = false;
  for (const i of items) {
    const add = 1 + line(i).length;
    if (!full && len + add <= budgetChars) { keep.push(i); len += add; } else { full = true; dropped.push({ id: i.id, reason: 'budget' }); }
  }
  if (!keep.length) return { items: [], text: '', dropped };
  return { items: keep, text: [HEADER, ...keep.map(line)].join('\n'), dropped };
}

function hintOf(items) {
  return items.filter((i) => i.trust === 'owner' && i.sensitivity !== 'private' && (i.kind === 'state' || i.kind === 'task'))
    .map((i) => i.text.replace(/\s+/g, ' ').trim()).join(' ').slice(0, HINT_MAX);
}

function callProvider(p, request, timeoutMs) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
  const run = new Promise((res) => res(p.fetch(request)));
  run.catch(() => {}); // a late rejection after the timeout must not be unhandled
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

function createAssembler({ providers = [], now = Date.now, budgetChars = 800, timeoutMs = 300 } = {}) {
  async function assemble(request = {}) {
    const t0 = Date.now();
    try {
      const req = request && typeof request === 'object' ? request : {};
      if (req.speaker !== undefined && req.speaker !== 'owner') return empty(t0);
      const errors = [], raw = [];
      await Promise.all((providers || []).map(async (p) => {
        const name = p && typeof p.name === 'string' ? p.name : 'unknown';
        try {
          const out = await callProvider(p, req, timeoutMs);
          if (!Array.isArray(out)) throw new Error('provider returned ' + (out === null ? 'null' : typeof out) + ', expected array');
          raw.push(...out);
        } catch (e) { errors.push({ provider: name, error: errMsg(e) }); }
      }));
      const dropped = [];
      const step = (r) => { dropped.push(...r.dropped); return r.items; };
      let items = step(validate(raw));
      items = redact(items);
      items = step(access(items, req));
      items = step(freshen(items, now()));
      items = step(supersede(items));
      items = rank(items);
      items = step(dedupe(items));
      const b = budget(items, budgetChars);
      dropped.push(...b.dropped);
      return { items: b.items, text: b.text, hint: hintOf(b.items), dropped, errors, ms: Date.now() - t0 };
    } catch (e) {
      return { ...empty(t0), errors: [{ provider: 'assembler', error: errMsg(e) }] };
    }
  }
  return { assemble };
}

module.exports = { createAssembler };
