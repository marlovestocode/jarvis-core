// Which skill groups a turn loads. Score = sum of the weights of the triggers that match, +1 for a group used
// last turn (only when something already matched). Top 2 groups with score >= 2; ties go to catalog order.
const { createRanker } = require('./rank');
const THRESHOLD = 2;
const MAX_GROUPS = 2;
const FOLLOW_UP = 1;
const HIGH = 3;
const LEAD_MIN = 4;       // an area leads the other only with at least this lexical score...
const LEAD_RATIO = 1.6;   // ...and this much more than the other
// A short message that only makes sense after the one before it: it starts with a connector or refers back with a pronoun.
const FOLLOW_UP_TEXT = /^\W*(?:(?:and|also|then|now|or|but|so)\s+(?:then\s+)?(?:cancel|stop|undo|delete|remove|pause|skip|make|set|change|turn|close|open|play|restart)|now|actually|what about|how about|make it|change it|set it|a (?:bit|little)|something|another|more|less|again|same|the other|cancel|undo|never ?mind)\b|\b(?:it|that|this|them|those)\W*$/i;

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

// Two areas last turn: the one whose tools the message reads closest to; when the message says nothing that separates them, both (the cap is two).
const rankers = new WeakMap();
function closestAreas(text, prev, catalog) {
  let rk = rankers.get(catalog);
  if (!rk) { rk = createRanker(catalog.groups.flatMap(g => g.tools)); rankers.set(catalog, rk); }
  const best = new Map();
  for (const id of prev) {
    const only = new Set(catalog.groups.find(g => g.id === id).tools.map(t => t.name));
    best.set(id, rk.best(text, { only })?.score || 0);
  }
  // a clear lead only: a weak or close score is word noise, and loading both areas costs a few tool definitions, not a wrong answer
  const order = [...best.entries()].sort((x, y) => y[1] - x[1]);
  const [first, second] = [order[0], order[1]];
  return first[1] >= LEAD_MIN && first[1] >= (second?.[1] || 0) * LEAD_RATIO ? [first[0]] : prev.slice(0, MAX_GROUPS);
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
  let picked = scored.slice(0, MAX_GROUPS).map(s => s.id);
  // nothing matched, but the message reads as a continuation ("actually make it 10", "something more upbeat"): same areas as the last turn
  let carried = false;
  if (!picked.length && FOLLOW_UP_TEXT.test(t) && t.trim().split(/\s+/).length <= 8) {
    const prev = lastGroups.filter(id => id !== 'core' && id !== 'knowledge' && catalog.groups.some(g => g.id === id));
    if (prev.length) { picked = prev.length === 1 ? prev : closestAreas(t, prev, catalog); carried = true; }
  }
  const out = picked.length ? ['core', ...picked] : ['core', ...(catalog.groups.some(g => g.id === 'knowledge') ? ['knowledge'] : [])];
  // How sure the match is, for the prompt and the metrics (hidden on the array so callers that compare or spread it are unchanged):
  //   high = the best group scores at least 3 and leads the next by 2 or more (or stands alone); medium = it cleared the threshold;
  //   low = nothing matched and the general fallback was used.
  const [a, b] = scored;
  const confidence = carried ? 'medium' : !a ? 'low' : a.score >= HIGH && (!b || a.score - b.score >= 2) ? 'high' : 'medium';
  Object.defineProperty(out, 'confidence', { value: confidence, enumerable: false });
  return out;
}

// Low-confidence turns only (nothing matched): one short constrained model call picks a group, or says ask / decline. The grammar
// limits the answer to the group ids plus 'ask' and 'decline', and ask / decline are spoken from fixed text, never from the model.
// Any failure (no constrain, a throw, an abort, a bad answer, a call over the budget) returns the rule result unchanged.
// selectWithModel(text, { provider, catalog, picked?, lastGroups?, signal?, hints?, budgetMs? }) -> { action: 'act' | 'ask' | 'decline', groups, question? }
const BUDGET_MS = 4000;
const ASK_TEXT = 'Could you tell me a bit more about what you would like me to do?';
const DECLINE_TEXT = "I'm afraid I don't have a tool for that.";

async function selectWithModel(text, { provider, catalog, picked, lastGroups = [], signal, hints, budgetMs = BUDGET_MS } = {}) {
  const rule = picked || selectGroups(text, { lastGroups }, catalog);
  const fallback = { action: 'act', groups: rule };
  if (rule.confidence !== 'low') return fallback;
  try {
    const hit = require('./clarify').clarify(text, { lastGroups });   // the hand-written rules answer first, with no model call
    if (hit) return { action: hit.kind, groups: rule, question: hit.reply };
    if (!provider?.constrain || signal?.aborted) return fallback;
    const areas = catalog.groups.filter(g => g.id !== 'core');
    const choices = [...areas.map(g => g.id), 'ask', 'decline'];
    const list = areas.map(g => `- ${g.id}: ${g.label}`).join('\n');
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const out = await Promise.race([
        provider.constrain({
          messages: [{ role: 'user', content: `Which skill area handles this request? Answer "ask" if it is too vague to act on, or "decline" if none of the areas can do it.\n${list}\nRequest: ${String(text).slice(0, 300)}` }],
          schema: { type: 'object', properties: { choice: { type: 'string', enum: choices } }, required: ['choice'], additionalProperties: false },
          signal: ac.signal, hints,
        }),
        new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error('over budget')); }, budgetMs); }),
      ]);
      const choice = out && typeof out === 'object' && typeof out.choice === 'string' ? out.choice : null;
      if (!choice || !choices.includes(choice)) return fallback;
      if (choice === 'ask') return { action: 'ask', groups: rule, question: ASK_TEXT };
      if (choice === 'decline') return { action: 'decline', groups: rule, question: DECLINE_TEXT };
      const groups = ['core', choice];
      Object.defineProperty(groups, 'confidence', { value: 'medium', enumerable: false });
      return { action: 'act', groups };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  } catch { return fallback; }
}

module.exports = { selectGroups, selectWithModel, THRESHOLD, MAX_GROUPS };
