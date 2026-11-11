// The JARVIS brain: prompt, router and the full tool set, in one place.
const { systemPrompt } = require('./prompt');
const { route } = require('./router');
const { loadGroups, buildCatalog } = require('../skills');

function defaultTools(opts = {}) {
  return buildCatalog(loadGroups(opts)).tools;
}

module.exports = { systemPrompt, route, defaultTools };
