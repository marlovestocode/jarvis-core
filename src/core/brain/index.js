// The JARVIS brain: prompt, router and the full tool set, in one place.
const { systemPrompt } = require('./prompt');
const { route } = require('./router');
const { timeTool } = require('../tools/time');
const { createSysmonTool } = require('../tools/sysmon');
const { createMediaTool, createMediaStatusTool, createYtMusicTool } = require('../tools/media');
const { skillTools, createStatusTool } = require('../tools/skills');
const { createKnowledgeTools } = require('../tools/knowledge');
const { createMemoryTools } = require('../tools/memory');
const { createMusicStatsTool } = require('../tools/musicstats');
const { createTimerTools } = require('../tools/timers');
const { createPcTools } = require('../tools/pc');
const { createYtLibraryTool, createYtPlayLibraryTool, createYtEditTool } = require('../tools/ytplaylists');

function defaultTools({ getStatus, fetch, fetcher, kiwix, getConfig, bus, media, ytm, ytPlaylists, memory, playLog, scheduler, pc } = {}) {
  const tools = [timeTool, ...skillTools(), createSysmonTool({ fetch }), createMediaTool({ fetch, service: media })];
  if (media) tools.push(createMediaStatusTool({ service: media }));
  if (ytm) tools.push(createYtMusicTool({ ytm }));
  if (ytPlaylists) tools.push(createYtLibraryTool({ playlists: ytPlaylists }), createYtPlayLibraryTool({ playlists: ytPlaylists }), createYtEditTool({ playlists: ytPlaylists }));
  if (playLog) tools.push(createMusicStatsTool({ playLog, playlistName: id => ytPlaylists?.titleOf?.(id) || null }));
  if (memory) tools.push(...createMemoryTools({ memory }));
  if (scheduler) tools.push(...createTimerTools({ scheduler }));
  if (pc) tools.push(...createPcTools({ ...pc, media }));
  if (getStatus) tools.push(createStatusTool({ getStatus }));
  if (fetcher) tools.push(...createKnowledgeTools({ fetcher, kiwix, getConfig, bus }));
  return tools;
}

module.exports = { systemPrompt, route, defaultTools };
