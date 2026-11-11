const { createYtLibraryTool, createYtPlayLibraryTool, createYtEditTool } = require('../../tools/ytplaylists');
const { createMusicStatsTool } = require('../../tools/musicstats');
const { own } = require('../util');

function createGroup({ ytPlaylists, playLog } = {}) {
  const tools = [];
  if (ytPlaylists) tools.push(createYtLibraryTool({ playlists: ytPlaylists }), createYtPlayLibraryTool({ playlists: ytPlaylists }), createYtEditTool({ playlists: ytPlaylists }));
  if (playLog) tools.push(createMusicStatsTool({ playLog, playlistName: id => ytPlaylists?.titleOf?.(id) || null }));
  return { id: 'ytmusic', label: 'YouTube Music library, playlists and listening stats', triggers: [], tools: tools.map(t => own(t)) };
}

module.exports = { createGroup };
