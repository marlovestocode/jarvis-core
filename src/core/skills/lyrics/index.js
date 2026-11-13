const { createLyricsTools } = require('../../tools/lyrics');
const { own } = require('../util');

function createGroup({ lyrics } = {}) {
  const tools = lyrics ? createLyricsTools({ lyrics }) : [];
  return { id: 'lyrics', label: 'Song lyrics, and finding a song from a line', triggers: [
    { re: /\b(?:find|get|show|what are) the (?:words|lyrics) (?:to|of|for)\b/i, w: 3 },
    { words: ['lyrics', 'lyric'], w: 3 },
    { re: /\b(?:what|which) (?:song|track) (?:goes|says|has)\b/i, w: 3 },
    { re: /\b(?:next|following) line\b/i, w: 2 },
  ], tools: tools.map(t => own(t, [], { untrusted: true })) };
}

module.exports = { createGroup };
