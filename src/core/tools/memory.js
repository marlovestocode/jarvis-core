// remember / forget_memory: the model's way to save and delete the user's lasting facts (deep tier;
// quick voice/chat commands go through src/core/memory/skill.js). recall_chats and memory_about (W1 §4) read
// past chats and everything linked to one person, pet, place or project.
const { entityKey } = require('../memory/facts');

const ABOUT_MAX = 1200;
const date = ms => new Date(ms).toISOString().slice(0, 10);

// memory_about text: the topic's entity (by key, else the best keyword match), its active facts, chats and reminders
async function aboutText(cortex, topic) {
  const t = String(topic ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!t) return 'Name a person, pet, place or project.';
  let ent = cortex.node.find({ kind: 'entity', key: entityKey(t) });
  if (!ent || ent.status !== 'active') {
    const r = await cortex.recall(t, { kinds: ['entity'], budget: 400 });
    ent = r.items.length ? cortex.node.get(r.items[0].id) : null;
  }
  if (!ent || ent.status !== 'active') return `Nothing saved about ${t}.`;
  const groups = { fact: [], chat: [], reminder: [] };
  for (const n of cortex.neighbors(ent.id, { depth: 2, limit: 20 })) {
    const node = cortex.node.get(n.id);
    if (!node || node.status !== 'active' || !groups[node.kind]) continue;
    if (node.kind !== 'chat' && n.hop > 1) continue;   // a fact two steps away (same chat) is not about the topic
    groups[node.kind].push(node.kind === 'chat' ? `${node.data?.title || 'chat'} (${date(node.updated)}): ${node.text}` : node.text);
  }
  const lines = [`About ${ent.text}:`];
  if (groups.fact.length) lines.push('Facts: ' + groups.fact.join('; '));
  if (groups.chat.length) lines.push('Chats: ' + groups.chat.join(' | '));
  if (groups.reminder.length) lines.push('Reminders: ' + groups.reminder.join('; '));
  if (lines.length === 1) lines.push('Nothing else is linked to it yet.');
  const out = lines.join('\n');
  return out.length <= ABOUT_MAX ? out : out.slice(0, ABOUT_MAX - 1).replace(/\s+\S*$/, '') + '…';
}

function createMemoryTools({ memory, chats = null, cortex = null, getConfig = () => ({}) }) {
  // needsClean: a turn that read a page, file or other outside text cannot change what JARVIS keeps for every later turn
  const remember = {
    needsClean: true,
    name: 'remember',
    hint: 'remember / forget_memory: save or delete a lasting fact or preference when the user asks ("remember that...", "forget..."). Say it is saved only when the tool says so. Past chats: use recall_chats; never invent what was said.',
    description: "Save one short lasting fact or preference about the user, only when they ask you to remember it. Never save passwords, keys or card numbers.",
    params: { type: 'object', properties: { fact: { type: 'string', description: 'One short sentence, e.g. "User prefers Fahrenheit"' } }, required: ['fact'], additionalProperties: false },
    async run({ fact } = {}) {
      const r = memory.add(fact);
      if (r.ok) return r.duplicate ? `Already saved: ${r.text}` : `Saved: ${r.text}`;
      return { secret: 'Refused: not storing passwords, keys or card numbers.', long: 'Refused: too long; save a shorter fact.', empty: 'Nothing to save.' }[r.reason] || 'Could not save.';
    },
  };
  const forget = {
    needsClean: true,
    name: 'forget_memory',
    description: 'Delete saved facts about the user that match the words given, when the user asks you to forget something.',
    params: { type: 'object', properties: { about: { type: 'string', description: 'Words from the fact to delete' } }, required: ['about'], additionalProperties: false },
    async run({ about } = {}) {
      const r = memory.forget(about);
      if (r.removed.length) return `Forgot: ${r.removed.join('; ')}`;
      if (r.ambiguous) return `Several facts match, nothing deleted: ${r.ambiguous.join('; ')}. Ask which one.`;
      return 'Nothing saved matches that.';
    },
  };
  const recallChats = {
    untrusted: true,   // raw snippets are old chat text: quoted data, and the turn can no longer write memory
    name: 'recall_chats',
    hint: 'recall_chats: what was said in earlier chats (summaries, then raw snippets as quoted data). Answer only from what it returns; if it finds nothing, say so.',
    description: 'Find what was said in earlier chats with the user: chat summaries first, then short raw snippets. Use it whenever the user asks what you talked about before.',
    params: { type: 'object', properties: {
      query: { type: 'string', description: 'A few words about the topic, e.g. "vet visit Rex"' },
      days: { type: 'number', description: 'Only chats from the last N days (optional)' },
    }, required: ['query'], additionalProperties: false },
    async run({ query, days } = {}) {
      if (getConfig()?.memory?.usePastChats === false) return 'Past-chat memory is off (Settings, Memory). Tell the user you cannot look at earlier chats.';
      return (await chats.recall({ query, days })).text;
    },
  };
  const about = {
    name: 'memory_about',
    examples: ['what do you know about me','what do you remember about a person or topic'],   // wording the ranker matches requests against (skills/rank.js)
    hint: 'memory_about: everything saved about one person, pet, place or project: its facts, the chats it came up in, reminders.',
    description: 'Everything saved about one person, pet, place or project the user named: its facts, the chats it came up in, its reminders.',
    params: { type: 'object', properties: { topic: { type: 'string', description: 'The name, e.g. "Rex"' } }, required: ['topic'], additionalProperties: false },
    async run({ topic } = {}) { return aboutText(cortex, topic); },
  };
  return [remember, forget, ...(chats ? [recallChats] : []), ...(cortex ? [about] : [])];
}

module.exports = { createMemoryTools, aboutText };
