const { createSysmonTool } = require('../../tools/sysmon');
const { own } = require('../util');

function createGroup({ fetch } = {}) {
  return { id: 'system', label: 'PC hardware stats (CPU, GPU, RAM, temperatures)', triggers: [], tools: [own(createSysmonTool({ fetch }), ['system_stats'])] };
}

module.exports = { createGroup };
