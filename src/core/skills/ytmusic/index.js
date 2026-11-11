const { createYtLibraryTool, createYtPlayLibraryTool, createYtEditTool } = require('../../tools/ytplaylists');
const { createMusicStatsTool } = require('../../tools/musicstats');
const { own } = require('../util');

function createGroup({ ytPlaylists, playLog } = {}) {
  const tools = [];
  if (ytPlaylists) tools.push(createYtLibraryTool({ playlists: ytPlaylists }), createYtPlayLibraryTool({ playlists: ytPlaylists }), createYtEditTool({ playlists: ytPlaylists }));
  if (playLog) tools.push(createMusicStatsTool({ playLog, playlistName: id => ytPlaylists?.titleOf?.(id) || null }));
  return { id: 'ytmusic', label: 'YouTube Music library, playlists and listening stats', triggers: [
    { words: ['playlist', 'playlists', 'liked', 'listening', 'taste'], w: 3 },
    { re: /\badd (?:this|it|that|the current song|the song)(?: song)? to\b/i, w: 3 },
    { re: /\btop (?:artists?|tracks?|songs?)\b/i, w: 3 },
    // "add trackstar by scrim to main 2": a playlist name without the word playlist
    { re: /^(?!.*\b(?:queue|total|cart|calendar|timer|list)\b)\W*add\b.+\b(?:by|song|track|this|that)\b.+\b(?:to|in|into)\b\s+(?:the |my )?[\w' $]+$/i, w: 2 },
    { re: /\b(?:surprise me|you(?:'d| would) (?:think )?i(?:'d| would)? (?:like|enjoy|love)|something i(?:'d| would)? (?:like|enjoy)|your picks?)\b/i, w: 3 },
    { re: /\bmy (?:\w+ ){1,3}playlist\b/i, w: 2 },
    { re: /\bliked (?:songs?|tracks?|music)\b/i, w: 2 },
  ], tools: tools.map(t => own(t)) };
}

module.exports = { createGroup };
