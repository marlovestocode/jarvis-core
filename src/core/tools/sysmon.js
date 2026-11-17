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

// process_top: the heaviest apps on this PC right now, from the PC host (grouped by app name)
function createProcessTopTool({ host }) {
  const gb = mb => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  const clock = s => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
  return {
    name: 'process_top', risk: 'safe', effect: 'read', volatile: true,
    examples: ['which apps use the most ram', 'what is using all my memory', 'heaviest tasks running', 'top processes'],
    hint: 'process_top: the apps using the most memory (by memory) or CPU time (by cpu), grouped by app. For total RAM or CPU load use get_system_stats.',
    description: 'List the apps using the most memory or CPU time right now (grouped by app name). by: memory (default) or cpu (total CPU time used so far, not a live percent). count: 1 to 25, default 5.',
    params: { type: 'object', properties: { by: { description: 'memory or cpu', type: 'string', enum: ['memory', 'cpu'] }, count: { description: 'how many apps, 1 to 25 (default 5)', type: 'integer', minimum: 1, maximum: 25 } }, additionalProperties: false },
    async run({ by = 'memory', count = 5 } = {}) {
      const rows = await host.processTop(by, count);
      if (!rows.length) return 'I could not read the running apps.';
      const line = (p, i) => `${i + 1}. ${p.name}${p.count > 1 ? ` (${p.count} processes)` : ''}: ${by === 'cpu' ? `${clock(p.cpuSec)} of CPU time` : gb(p.memMB)}`;
      return `Top ${rows.length} by ${by === 'cpu' ? 'CPU time used so far' : 'memory'}: ${rows.map(line).join('; ')}.`;
    },
  };
}

function createSysmonTool({ fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  return {
    name: 'get_system_stats',
    volatile: true,
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

module.exports = { createProcessTopTool, createSysmonTool, summarize, SYSMON };
