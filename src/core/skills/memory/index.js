const { createMemoryTools } = require('../../tools/memory');
const { own } = require('../util');

function createGroup({ memory, chats, cortex, getConfig } = {}) {
  const tools = memory ? createMemoryTools({ memory, chats, cortex, getConfig }) : [];
  return { id: 'memory', label: 'Remember and forget facts about the user; recall past chats', triggers: [
    { words: ['remember', 'forget', 'my name is', 'call me'], w: 3 },
    { words: ['did we talk', 'we discussed', 'what do you know about', 'remember about'], w: 3 },
    { re: /\b(?:transcripts?|chat (?:history|logs?)|(?:past|previous|earlier|old) (?:chats?|conversations?))\b/i, w: 3 },
    { re: /\b(?:note|keep in mind|don'?t forget) that\b|\bwhat (?:have|did) i (?:told|tell|said|say) you\b|\bwhat do you (?:know|remember) about\b/i, w: 3 },
    { re: /\b(?:list|show|read)(?: me)?(?: all| everything)?(?: of)? (?:my|your|the) (?:memories|saved (?:facts|memories|memory)|memory)\b|\bwhat (?:do you|have you) (?:remember|saved|stored)(?: about me)?\b|\beverything you (?:have|'ve) saved\b/i, w: 3 },
  ], tools: tools.map(t => own(t)) };
}

module.exports = { createGroup };
