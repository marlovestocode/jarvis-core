// The user's named lists: grocery, todo and so on. Stored locally (src/core/lists/store.js); clearing one asks first.
const { createListTools } = require('../../tools/lists');
const { own } = require('../util');

function createGroup({ lists, pc } = {}) {
  if (!lists) return null;
  return { id: 'lists', label: 'Named lists: grocery, todo, shopping', triggers: [
    { re: /\b(?:grocery|shopping|todo|to-do|to do|packing) list\b|\b(?:add|put) .{1,60} (?:to|on|onto) (?:my |the )?[\w' -]{1,30} list\b|\b(?:what(?:'s| is)|show|read)(?: me)? (?:on |in )?(?:my |the )[\w' -]{1,30} list\b|\bmy lists\b/i, w: 3 },
    { words: ['list', 'lists'], w: 1 },
  ], tools: createListTools({ lists, confirm: pc?.confirm || null }).map(t => own(t)) };
}

module.exports = { createGroup };
