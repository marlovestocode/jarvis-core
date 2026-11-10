// remember / forget_memory: the model's way to save and delete the user's lasting facts (deep tier;
// quick voice/chat commands go through src/core/memory/skill.js).
function createMemoryTools({ memory }) {
  const remember = {
    name: 'remember',
    description: "Save one short lasting fact or preference about the user, only when they ask you to remember it. Never save passwords, keys or card numbers.",
    params: { type: 'object', properties: { fact: { type: 'string', description: 'One short sentence, e.g. "User prefers Fahrenheit"' } }, required: ['fact'], additionalProperties: false },
    async run({ fact } = {}) {
      const r = memory.add(fact);
      if (r.ok) return r.duplicate ? `Already saved: ${r.text}` : `Saved: ${r.text}`;
      return { secret: 'Refused: not storing passwords, keys or card numbers.', long: 'Refused: too long; save a shorter fact.', empty: 'Nothing to save.' }[r.reason] || 'Could not save.';
    },
  };
  const forget = {
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
  return [remember, forget];
}

module.exports = { createMemoryTools };
