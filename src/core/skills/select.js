// Which skill groups a turn loads. Score = sum of the weights of the triggers that match, +1 for a group used
// last turn (only when something already matched). Top 2 groups with score >= 2; ties go to catalog order.
const THRESHOLD = 2;
const MAX_GROUPS = 2;
const FOLLOW_UP = 1;

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new WeakMap();

function matcher(trigger) {
  let re = compiled.get(trigger);
  if (!re) {
    re = trigger.re || new RegExp(`\\b(?:${(trigger.words || []).map(esc).join('|')})\\b`, 'i');
    compiled.set(trigger, re);
  }
  return re;
}

function scoreGroup(group, text) {
  let sum = 0;
  for (const trigger of group.triggers || []) {
    if (trigger.re || trigger.words?.length) if (matcher(trigger).test(text)) sum += trigger.w || 0;
  }
  return sum;
}

function selectGroups(text, { lastGroups = [] } = {}, catalog) {
  const t = String(text || '');
  const scored = [];
  catalog.groups.forEach((g, order) => {
    if (g.id === 'core') return;
    let score = scoreGroup(g, t);
    if (score > 0 && lastGroups.includes(g.id)) score += FOLLOW_UP;
    if (score >= THRESHOLD) scored.push({ id: g.id, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const picked = scored.slice(0, MAX_GROUPS).map(s => s.id);
  if (picked.length) return ['core', ...picked];
  return ['core', ...(catalog.groups.some(g => g.id === 'knowledge') ? ['knowledge'] : [])];
}

module.exports = { selectGroups, THRESHOLD, MAX_GROUPS };
