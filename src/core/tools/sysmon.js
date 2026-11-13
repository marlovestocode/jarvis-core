// get_system_stats: reads the sysmon bridge snapshot (127.0.0.1:47800, local only).
const { SYSMON } = require('../net/services');

const pct = v => (typeof v === 'number' && isFinite(v) ? Math.round(v) + '%' : null);
const deg = v => (typeof v === 'number' && isFinite(v) ? Math.round(v) + '°C' : null);
function rate(b) {
  if (typeof b !== 'number' || !isFinite(b)) return null;
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB/s';
  if (b >= 1e3) return Math.round(b / 1e3) + ' KB/s';
  return Math.round(b) + ' B/s';
}

function summarize(s) {
  const parts = [];
  if (s.cpu) parts.push(['CPU', pct(s.cpu.load), deg(s.cpu.temp) && `(${deg(s.cpu.temp)})`].filter(Boolean).join(' '));
  if (s.gpu) parts.push(['GPU', pct(s.gpu.load), deg(s.gpu.temp) && `(${deg(s.gpu.temp)})`].filter(Boolean).join(' '));
  if (s.mem) parts.push(`RAM ${pct(s.mem.pct)}`);
  if (s.net) parts.push(`network down ${rate(s.net.rx)} up ${rate(s.net.tx)}`);
  if (s.disk) {
    if (s.disk.read != null || s.disk.write != null) parts.push(`disk read ${rate(s.disk.read) || '0 B/s'} write ${rate(s.disk.write) || '0 B/s'}`);
    if (Array.isArray(s.disk.volumes) && s.disk.volumes.length) parts.push('drives ' + s.disk.volumes.map(v => `${String(v.mount).replace(/\\$/, '')} ${pct(v.pct)} used`).join(', '));
  }
  return parts.join('; ') + '.';
}

function createSysmonTool({ fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  return {
    name: 'get_system_stats',
    examples: ['how hot is my graphics card','cpu gpu ram usage load','computer performance temperature'],   // wording the ranker matches requests against (skills/rank.js)
    hint: 'get_system_stats: live CPU/GPU load, temperatures, memory in use, VRAM, network, disk. Use it for any "how much memory/CPU/GPU is used" question, including JARVIS own use.',
    description: 'Get current PC stats from the local system monitor: CPU, GPU, RAM, network, disk.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx = {}) {
      let r;
      try {
        r = await fetch(`${SYSMON}/snapshot`, { signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new Error('Sysmon is not running');
      }
      if (!r.ok) throw new Error('Sysmon is not running');
      const s = await r.json();
      if (!s || typeof s !== 'object' || !s.t) throw new Error('Sysmon has no data yet');
      return summarize(s);
    },
  };
}

module.exports = { createSysmonTool, summarize, SYSMON };
