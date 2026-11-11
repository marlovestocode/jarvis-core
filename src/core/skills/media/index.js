const { createMediaTool, createMediaStatusTool, createYtMusicTool } = require('../../tools/media');
const { own } = require('../util');

function createGroup({ fetch, media, ytm } = {}) {
  const tools = [own(createMediaTool({ fetch, service: media }), ['set_volume', 'media'])];
  if (media) tools.push(own(createMediaStatusTool({ service: media }), ['get_volume']));
  if (ytm) tools.push(own(createYtMusicTool({ ytm }), ['ytm_music', 'youtube', 'play_music']));
  return { id: 'media', label: 'Music and media playback, volume', triggers: [
    { words: ['play', 'pause', 'resume', 'skip', 'louder', 'quieter', 'mute', 'unmute', 'shuffle', 'queue', 'song', 'songs', 'track', 'tracks', 'album', 'albums', 'spotify'], w: 3 },
    { re: /^(?!.*\b(?:brightness|screen|display|lights?)\b).*\bturn (?:it |the \w+ )?(?:up|down)\b/i, w: 3 },
    { words: ['volume', 'music'], w: 2 },
  ], tools };
}

module.exports = { createGroup };
