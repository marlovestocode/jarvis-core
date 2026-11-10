// Network policy (spec §3): the allowlist, the master switch and per-source switches.
// Exact host match on https URLs with no userinfo, no port, no IP literals. Feed hosts come from config.
const BASE_HOSTS = Object.freeze([
  'api.open-meteo.com', 'geocoding-api.open-meteo.com', 'air-quality-api.open-meteo.com',
  'api.weather.gov', 'en.wikipedia.org', 'site.api.espn.com',
]);
const SOURCES = ['weather', 'news', 'sports', 'wiki'];

function feedHosts(config) {
  const out = [];
  for (const u of config?.news?.feeds || []) {
    try { const x = new URL(u); if (x.protocol === 'https:' && !x.username && !x.password && !x.port) out.push(x.hostname); } catch { /* bad feed url */ }
  }
  return out;
}

function createPolicy(getConfig) {
  function hosts() { return [...new Set([...BASE_HOSTS, ...feedHosts(getConfig())])]; }

  function allowed(url, source) {
    const c = getConfig() || {};
    if (c.online && c.online.enabled === false) return { ok: false, reason: 'online lookups are off' };
    if (source && SOURCES.includes(source) && c.online && c.online[source] === false) return { ok: false, reason: `${source} lookups are off` };
    let u;
    try { u = new URL(String(url)); } catch { return { ok: false, reason: 'refused: not a valid URL' }; }
    if (u.protocol !== 'https:') return { ok: false, reason: 'refused: https only' };
    if (u.username || u.password) return { ok: false, reason: 'refused: credentials in URL' };
    if (u.port) return { ok: false, reason: 'refused: non-default port' };
    // the host must be written exactly as allowlisted (lower case), not normalised into it
    const raw = String(url).slice(u.protocol.length + 2).split(/[/?#]/)[0];
    if (raw !== u.hostname) return { ok: false, reason: `refused: host ${raw} not allowed` };
    if (!hosts().includes(u.hostname)) return { ok: false, reason: `refused: host ${u.hostname} not allowed` };
    return { ok: true, host: u.hostname };
  }

  return { allowed, hosts };
}

module.exports = { createPolicy, BASE_HOSTS, SOURCES };
