const { createSysmonTool } = require('../../tools/sysmon');
const { sysmonUp } = require('../../net/services');
const { own } = require('../util');

function createGroup({ fetch } = {}) {
  const get = fetch || globalThis.fetch;
  const status = async () => {
    return (await sysmonUp(get, 800)) ? { ok: true, detail: 'sysmon running' } : { ok: false, detail: 'sysmon is not running' };
  };
  return { status, id: 'system', label: 'PC hardware stats (CPU, GPU, RAM, temperatures)', triggers: [
    { re: /\b(?:graphics card|video card|processor|how (?:hot|warm) is my|how much (?:memory|ram) (?:is )?(?:free|used|left|available)|memory (?:usage|use)|is my (?:pc|computer|cpu|gpu|processor|machine) (?:busy|slow|hot|overheating|struggling))\b/i, w: 3 },
    { words: ['cpu', 'gpu', 'ram', 'vram', 'temperature', 'temperatures', 'fps', 'sysmon'], w: 3 },
    { re: /\bdisk usage\b/i, w: 3 },
  ], tools: [own(createSysmonTool({ fetch }), ['system_stats'])] };
}

module.exports = { createGroup };
