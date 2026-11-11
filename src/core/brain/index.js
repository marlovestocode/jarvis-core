// The JARVIS brain: prompt, router and the full tool set, in one place.
const { systemPrompt } = require('./prompt');
const { route } = require('./router');
const { loadGroups, buildCatalog } = require('../skills');

// the skill catalog (groups, tools, aliases) for these dependencies
function defaultCatalog(opts = {}) {
  return buildCatalog(loadGroups(opts));
}

function defaultTools(opts = {}) {
  return defaultCatalog(opts).tools;
}

module.exports = { systemPrompt, route, defaultTools, defaultCatalog };
