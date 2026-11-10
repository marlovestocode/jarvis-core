// The JARVIS brain: prompt, router and the full tool set, in one place.
const { systemPrompt } = require('./prompt');
const { route } = require('./router');
const { timeTool } = require('../tools/time');
const { createSysmonTool } = require('../tools/sysmon');
const { createMediaTool } = require('../tools/media');
const { skillTools, createStatusTool } = require('../tools/skills');
const { createKnowledgeTools } = require('../tools/knowledge');

function defaultTools({ getStatus, fetch, fetcher, kiwix, getConfig, bus } = {}) {
  const tools = [timeTool, ...skillTools(), createSysmonTool({ fetch }), createMediaTool({ fetch })];
  if (getStatus) tools.push(createStatusTool({ getStatus }));
  if (fetcher) tools.push(...createKnowledgeTools({ fetcher, kiwix, getConfig, bus }));
  return tools;
}

module.exports = { systemPrompt, route, defaultTools };
