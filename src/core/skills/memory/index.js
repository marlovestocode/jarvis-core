const { createMemoryTools } = require('../../tools/memory');
const { own } = require('../util');

function createGroup({ memory } = {}) {
  const tools = memory ? createMemoryTools({ memory }) : [];
  return { id: 'memory', label: 'Remember and forget facts about the user', triggers: [
    { words: ['remember', 'forget', 'my name is', 'call me'], w: 3 },
  ], tools: tools.map(t => own(t)) };
}

module.exports = { createGroup };
