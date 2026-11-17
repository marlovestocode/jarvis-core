// StockMan configuration: defaults < optional JSON file in the data folder < STOCKMAN_* environment variables.
// Secrets are never read here (see secrets.js); a secret-looking key in the file is refused, so none gets committed or backed up.
// Own file, not src/core/config.js: that file carries jarvis-wide switches and is a guarded file in the vault.
// A wrong value is an error, not a silent fallback (vault rule: fail loudly).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigError } = require('./errors');

const DEFAULTS = Object.freeze({
  enabled: true,
  db: Object.freeze({ file: 'stockman.db', eventRetentionDays: 30 }),
  provider: Object.freeze({
    name: 'yahoo',
    timeoutMs: 8000,        // one HTTP attempt (jarvis fetcher default is 8 s)
    deadlineMs: 30000,      // one whole call, all retries included
    retries: 2,             // extra attempts after the first
    retryBaseMs: 250, retryMaxMs: 5000,
    ratePerSec: 5,          // sustained requests per second; the 2026-11-14 sweep ran at ~6.7/s (150 ms pacing) without limits
    burst: 2,
    breakerFailures: 5,     // consecutive provider failures before the circuit opens
    breakerCooldownMs: 30000,
  }),
  log: Object.freeze({ level: 'info', eventLevel: 'warn' }),   // eventLevel: lowest level also written to engine_event
  // paper-trade opener (trading/paper.js): OFF by default. Vault note 06: paper trading starts only after the rule passes the tuning period.
  paperTrading: Object.freeze({ enabled: false }),
  // Alpaca PAPER order methods (trading/alpaca.js, vault D23): OFF by default. Reading (account, clock, quotes) needs only online.broker in jarvis's config.
  // The keys are never configured here: ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET_KEY, environment only.
  broker: Object.freeze({ enabled: false, maxNotionalUsd: 1000, capitalUsd: 20000 }),
  // the sandbox strategy track (trading/sandbox, vault D28): OFF by default. The third of three switches (online.broker, broker.enabled, sandbox.enabled);
  // the strategy file cannot turn any of them on. `killed` is written by the daily-loss kill switch in the sandbox state file, not here.
  sandbox: Object.freeze({ enabled: false }),
});

const LEVELS = ['debug', 'info', 'warn', 'error'];
const PROVIDERS = ['yahoo', 'mock'];
const SECRET_KEY = /key|token|secret|password|passwd|authorization|cookie|crumb/i;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// [section, key, check, describe]
const RULES = [
  ['', 'enabled', v => typeof v === 'boolean', 'true or false'],
  ['db', 'file', v => typeof v === 'string' && !!v.trim() && !/[\\/]/.test(v), 'a file name without folders'],
  ['db', 'eventRetentionDays', v => Number.isInteger(v) && v >= 1 && v <= 3650, 'a whole number of days, 1 to 3650'],
  ['provider', 'name', v => PROVIDERS.includes(v), `one of ${PROVIDERS.join(', ')}`],
  ['provider', 'timeoutMs', v => Number.isInteger(v) && v >= 500 && v <= 60000, 'milliseconds, 500 to 60000'],
  ['provider', 'deadlineMs', v => Number.isInteger(v) && v >= 1000 && v <= 300000, 'milliseconds, 1000 to 300000'],
  ['provider', 'retries', v => Number.isInteger(v) && v >= 0 && v <= 5, 'a whole number, 0 to 5'],
  ['provider', 'retryBaseMs', v => Number.isInteger(v) && v >= 10 && v <= 60000, 'milliseconds, 10 to 60000'],
  ['provider', 'retryMaxMs', v => Number.isInteger(v) && v >= 10 && v <= 120000, 'milliseconds, 10 to 120000'],
  ['provider', 'ratePerSec', v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 50, 'a number above 0, up to 50'],
  ['provider', 'burst', v => Number.isInteger(v) && v >= 1 && v <= 50, 'a whole number, 1 to 50'],
  ['provider', 'breakerFailures', v => Number.isInteger(v) && v >= 1 && v <= 100, 'a whole number, 1 to 100'],
  ['provider', 'breakerCooldownMs', v => Number.isInteger(v) && v >= 100 && v <= 3600000, 'milliseconds, 100 to 3600000'],
  ['paperTrading', 'enabled', v => typeof v === 'boolean', 'true or false'],
  ['broker', 'enabled', v => typeof v === 'boolean', 'true or false'],
  ['sandbox', 'enabled', v => typeof v === 'boolean', 'true or false'],
  ['broker', 'capitalUsd', v => typeof v === 'number' && v >= 100 && v <= 1000000, 'US dollars the router spreads over 5 sleeves and the basket, 100 to 1000000'],
  ['broker', 'maxNotionalUsd', v => typeof v === 'number' && v > 0 && v <= 100000, 'a number of US dollars, above 0 and at most 100000'],
  ['log', 'level', v => LEVELS.includes(v), `one of ${LEVELS.join(', ')}`],
  ['log', 'eventLevel', v => LEVELS.includes(v), `one of ${LEVELS.join(', ')}`],
];

function defaultDataDir(env = process.env) {
  const own = env.STOCKMAN_DATA_DIR || env.JARVIS_DATA_DIR;   // JARVIS_DATA_DIR is what src/main/main.js honours
  if (own) return path.resolve(own);
  return path.join(env.APPDATA || path.join(os.homedir(), '.config'), 'jarvis-core');
}

function merge(raw, where) {
  if (raw === undefined) return {};
  if (!isObj(raw)) throw new ConfigError(`${where}: expected an object`);
  for (const [k, v] of Object.entries(raw)) {
    if (SECRET_KEY.test(k)) throw new ConfigError(`${where}: "${k}" looks like a secret. Secrets go in STOCKMAN_* environment variables, never in the config file`);
    if (isObj(v)) for (const kk of Object.keys(v)) if (SECRET_KEY.test(kk)) throw new ConfigError(`${where}: "${k}.${kk}" looks like a secret. Secrets go in STOCKMAN_* environment variables, never in the config file`);
  }
  return raw;
}

// env: STOCKMAN_ENABLED, STOCKMAN_PROVIDER, STOCKMAN_LOG_LEVEL, STOCKMAN_DB_FILE (names, no secrets)
function fromEnv(env) {
  const out = {};
  const bool = (n, v) => { if (/^(1|true|yes|on)$/i.test(v)) return true; if (/^(0|false|no|off)$/i.test(v)) return false; throw new ConfigError(`${n}: expected true or false, got "${v}"`); };
  if (env.STOCKMAN_ENABLED) out.enabled = bool('STOCKMAN_ENABLED', env.STOCKMAN_ENABLED);
  if (env.STOCKMAN_PROVIDER) out.provider = { name: env.STOCKMAN_PROVIDER };
  if (env.STOCKMAN_LOG_LEVEL) out.log = { level: env.STOCKMAN_LOG_LEVEL };
  if (env.STOCKMAN_DB_FILE) out.db = { file: env.STOCKMAN_DB_FILE };
  if (env.STOCKMAN_PAPER_TRADING) out.paperTrading = { enabled: bool('STOCKMAN_PAPER_TRADING', env.STOCKMAN_PAPER_TRADING) };
  if (env.STOCKMAN_SANDBOX) out.sandbox = { enabled: bool('STOCKMAN_SANDBOX', env.STOCKMAN_SANDBOX) };
  if (env.STOCKMAN_BROKER_ORDERS) out.broker = { enabled: bool('STOCKMAN_BROKER_ORDERS', env.STOCKMAN_BROKER_ORDERS) };
  return out;
}

// loadConfig({ env, dataDir, file, readFile }) → frozen { dataDir, dbPath, cacheDir, enabled, db, provider, log, source }
// file: JSON config path (default <dataDir>/stockman.config.json); a missing file is fine, a broken one is an error.
function loadConfig({ env = process.env, dataDir, file, readFile = p => fs.readFileSync(p, 'utf8'), overrides } = {}) {
  const dir = path.resolve(dataDir || defaultDataDir(env));
  const cfgFile = file || path.join(dir, 'stockman.config.json');
  let fileCfg = {}, fileFound = false;
  try {
    const text = readFile(cfgFile);
    fileFound = true;
    try { fileCfg = JSON.parse(text); } catch (err) { throw new ConfigError(`${cfgFile}: not valid JSON (${err.message})`); }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (err.code !== 'ENOENT') throw new ConfigError(`${cfgFile}: cannot read (${err.message})`, { cause: err });
  }
  const layers = [merge(fileCfg, cfgFile), merge(fromEnv(env), 'environment'), merge(overrides, 'overrides')];
  const out = { enabled: DEFAULTS.enabled, db: { ...DEFAULTS.db }, provider: { ...DEFAULTS.provider }, log: { ...DEFAULTS.log }, paperTrading: { ...DEFAULTS.paperTrading }, broker: { ...DEFAULTS.broker }, sandbox: { ...DEFAULTS.sandbox } };
  for (const layer of layers) {
    for (const [section, key, , ] of RULES) {
      const v = section ? (isObj(layer[section]) ? layer[section][key] : undefined) : layer[key];
      if (v !== undefined) (section ? out[section] : out)[key] = v;
    }
  }
  for (const [section, key, check, describe] of RULES) {
    const v = section ? out[section][key] : out[key];
    if (!check(v)) throw new ConfigError(`${section ? section + '.' : ''}${key}: expected ${describe}, got ${JSON.stringify(v)}`);
  }
  if (out.provider.retryMaxMs < out.provider.retryBaseMs) throw new ConfigError('provider.retryMaxMs must be at least provider.retryBaseMs');
  return Object.freeze({
    ...out,
    dataDir: dir,
    dbPath: path.join(dir, out.db.file),
    cacheDir: path.join(dir, 'stockman-cache'),
    source: fileFound ? cfgFile : 'defaults',
  });
}

module.exports = { loadConfig, defaultDataDir, DEFAULTS, LEVELS };
