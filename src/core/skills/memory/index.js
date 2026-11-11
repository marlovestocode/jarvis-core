const { createMemoryTools } = require('../../tools/memory');
const { own } = require('../util');

function createGroup({ memory, chats, cortex, getConfig } = {}) {
  const tools = memory ? createMemoryTools({ memory, chats, cortex, getConfig }) : [];
  return { id: 'memory', label: 'Remember and forget facts about the user; recall past chats', triggers: [
    { words: ['remember', 'forget', 'my name is', 'call me'], w: 3 },
    { words: ['did we talk', 'we discussed', 'what do you know about', 'remember about'], w: 3 },
  ], tools: tools.map(t => own(t)) };
}

module.exports = { createGroup };
