const { createSysmonTool } = require('../../tools/sysmon');
const { own } = require('../util');

function createGroup({ fetch } = {}) {
  return { id: 'system', label: 'PC hardware stats (CPU, GPU, RAM, temperatures)', triggers: [
    { words: ['cpu', 'gpu', 'ram', 'vram', 'temperature', 'temperatures', 'fps', 'sysmon'], w: 3 },
    { re: /\bdisk usage\b/i, w: 3 },
  ], tools: [own(createSysmonTool({ fetch }), ['system_stats'])] };
}

module.exports = { createGroup };
