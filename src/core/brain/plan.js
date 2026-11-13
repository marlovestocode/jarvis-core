// plan(): applies the live-state snapshot to the unchanged route() and selectGroups() results.
// Pure: route and selectGroups are injected. Rules run in order: continue, confirm, voice, cooldown, notes.
// With no snapshot the direct results are returned as they are. Exceptions from route/selectGroups propagate.
const { cooling } = require('./cooldown');

const CONFIRM_MAX_AGE_MS = 5 * 60000;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// a confirm is pending when it exists, is younger than 5 min (a missing age counts as young) and the message is not its yes/no
function confirmPending(snap, fu) {
  const c = snap.confirm;
  if (!isObj(c) || fu?.kind === 'confirm') return false;
  return !(Number.isFinite(c.ageMs) && c.ageMs >= CONFIRM_MAX_AGE_MS);
}

function knows(catalog, id) {
  const ids = catalog?.ids;
  if (Array.isArray(ids)) return ids.includes(id);
  if (ids instanceof Set) return ids.has(id);
  return false;
}

function mostRecentCooling(snap, models) {
  if (!models.size || !Array.isArray(snap.models)) return null;
  let best = null;
  for (const e of snap.models) {
    if (!isObj(e) || !models.has(e.name) || !Number.isFinite(e.t)) continue;
    if (!best || e.t > best.t) best = e;
  }
  return best ? best.name : null;
}

function plan(text, snap, { source, lastGroups, fu, catalog, route, selectGroups, now = Date.now() } = {}) {
  const live = isObj(snap) && Object.keys(snap).length > 0;
  const continuing = live && fu?.kind === 'continue';
  const seed = continuing ? fu.groups : lastGroups;

  let hints = route ? route(text, { source }) : undefined;
  let picked = selectGroups ? selectGroups(text, { lastGroups: seed, source }) : null;
  const notes = [];
  if (!live) return { hints, picked, avoid: { tools: new Set(), models: new Set() }, notes };

  // 1. follow-up continue (the former inline orchestrator logic)
  if (continuing) {
    if (selectGroups && fu.groups?.length && !picked?.some(id => id !== 'core')) picked = fu.groups;
    if (hints?.tools === false) hints = { ...hints, tier: 'deep', tools: true, think: false, reason: 'follow-up' };
  }

  // 2. pending confirm
  const pending = confirmPending(snap, fu);
  if (pending) {
    notes.push('confirm pending');
    if (hints?.tools === false) hints = { ...hints, tier: 'deep', tools: true, think: false, reason: 'confirm pending' };
    const g = snap.confirm.group;
    if (picked && typeof g === 'string' && knows(catalog, g) && !picked.includes(g)) picked = [...picked, g];
  }

  // 3. voice: a single-step, non-thinking request may use the fast model
  if (source === 'voice' && !pending && hints?.tier === 'deep' && hints.depth === 1 && hints.steps === 1 && !hints.think
      && (picked ? picked.filter(id => id !== 'core').length : 0) <= 1) {
    hints = { ...hints, prefer: 'fast' };
    notes.push('voice: fast');
  }

  // 4. cooldown
  const avoid = cooling(snap, now);
  const avoidModel = mostRecentCooling(snap, avoid.models);
  if (avoidModel && hints) hints = { ...hints, avoid: avoidModel };

  // 5. notes
  for (const name of avoid.tools) notes.push(`cooldown: ${name}`);
  for (const name of avoid.models) notes.push(`cooldown: ${name}`);

  return { hints, picked, avoid, notes };
}

module.exports = { plan };
