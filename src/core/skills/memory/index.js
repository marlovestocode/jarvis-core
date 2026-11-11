const { createMemoryTools } = require('../../tools/memory');
const { own } = require('../util');

function createGroup({ memory } = {}) {
  const tools = memory ? createMemoryTools({ memory }) : [];
  return { id: 'memory', label: 'Remember and forget facts about the user', triggers: [], tools: tools.map(t => own(t)) };
}

module.exports = { createGroup };
