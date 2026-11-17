// Secrets live outside source code and outside the config file: they come from the environment only (STOCKMAN_<NAME>).
// SecretProvider port: get(name) → string | undefined, has(name), values() → the non-empty secrets read so far (for log redaction).
// Phase one needs no secret (the Yahoo chart endpoint is keyless). The port exists so a later feature does not invent its own.
// Where a future key (broker, reviewer) is stored long term is an open vault decision (G22); this env provider is only the default.
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function createEnvSecrets({ env = process.env, prefix = 'STOCKMAN_' } = {}) {
  const seen = new Set();
  function get(name) {
    if (!NAME.test(name)) throw new Error(`bad secret name: ${name}`);
    const v = env[prefix + name];
    if (typeof v === 'string' && v.length) { seen.add(v); return v; }
    return undefined;
  }
  return { get, has: name => get(name) !== undefined, values: () => [...seen] };
}

// an in-memory provider for tests; the values it holds are test values only
function createStaticSecrets(map = {}) {
  return {
    get: name => (typeof map[name] === 'string' && map[name] ? map[name] : undefined),
    has: name => typeof map[name] === 'string' && !!map[name],
    values: () => Object.values(map).filter(v => typeof v === 'string' && v),
  };
}

const SECRET_KEY = /key|token|secret|password|passwd|authorization|cookie|crumb/i;

// redact(value, secrets): a copy with secret-looking fields masked and any known secret value removed from strings
function redact(value, secrets = [], depth = 0) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') {
    let s = value;
    for (const v of secrets) if (v.length >= 4) s = s.split(v).join('[redacted]');
    return s;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return redact(value.message, secrets, depth + 1);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, secrets, depth + 1);
    return out;
  }
  return value;
}

module.exports = { createEnvSecrets, createStaticSecrets, redact };
