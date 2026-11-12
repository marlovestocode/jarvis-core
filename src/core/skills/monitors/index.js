const { createMonitorTools } = require('../../tools/monitors');
const { own } = require('../util');

const ALIASES = {
  monitor_set: ['set_monitor', 'set_warning', 'set_alert', 'proactive_set', 'configure_monitor'],
};

function createGroup({ getConfig, applySettings } = {}) {
  const tools = applySettings ? createMonitorTools({ getConfig, applySettings }) : [];
  return { id: 'monitors', label: 'Proactive warnings (heads-ups about timers, RAM, CPU, disk)', triggers: [
    { re: /\b(?:warn|alert|notify|tell|let) me (?:when|if|before|ahead)\b/i, w: 3 },
    { re: /\bstop (?:warning|alerting|notifying) me\b/i, w: 3 },
    { words: ['proactive'], w: 3 },
  ], tools: tools.map(t => own(t, ALIASES[t.name] || [])) };
}

module.exports = { createGroup };
