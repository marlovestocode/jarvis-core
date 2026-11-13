// JARVIS's own introspection tools (tools/self.js). The group exists when the app gives it its checks.
const { createSelfTools } = require('../../tools/self');
const { createAnalyticsTools } = require('../../tools/analytics');
const { SELF } = require('../../brain/router');
const { own } = require('../util');

const ALIASES = {
  self_diagnostics: ['diagnostics', 'run_diagnostics', 'self_check', 'health_check'],
  skills_list: ['list_skills', 'list_tools'],
  self_config: ['get_config', 'get_version'],
  self_log: ['error_log', 'recent_errors'],
};

function createGroup({ self, analytics } = {}) {
  const tools = self ? [...createSelfTools(self), ...createAnalyticsTools(analytics)] : [];
  return { id: 'self', label: 'JARVIS self-check: diagnostics, list of skills, version and settings, error log', triggers: [
    { re: SELF, w: 3 },
    { re: /(?:dashboard|analytics|your (?:stats|statistics|metrics|performance|uptime|reliability)|how (?:have|are) you (?:been )?(?:doing|performing)|how reliable are you|usage stats)/i, w: 3 },
  // the log is text from outside (error messages can quote pages and files), so self_log is untrusted
  ], tools: tools.map(t => own(t, ALIASES[t.name] || [], t.name === 'self_log' ? { untrusted: true } : {})) };
}

module.exports = { createGroup };
