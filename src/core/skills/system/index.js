const { createSysmonTool, SYSMON } = require('../../tools/sysmon');
const { own } = require('../util');

function createGroup({ fetch } = {}) {
  const get = fetch || globalThis.fetch;
  const status = async () => {
    const r = await Promise.resolve().then(() => get(`${SYSMON}/health`, { signal: AbortSignal.timeout(800) })).catch(() => null);
    return r?.ok ? { ok: true, detail: 'sysmon running' } : { ok: false, detail: 'sysmon is not running' };
  };
  return { status, id: 'system', label: 'PC hardware stats (CPU, GPU, RAM, temperatures)', triggers: [
    { words: ['cpu', 'gpu', 'ram', 'vram', 'temperature', 'temperatures', 'fps', 'sysmon'], w: 3 },
    { re: /\bdisk usage\b/i, w: 3 },
  ], tools: [own(createSysmonTool({ fetch }), ['system_stats'])] };
}

module.exports = { createGroup };
