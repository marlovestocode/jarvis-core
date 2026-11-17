// The composition root: builds config, logger, secrets, link, stock service and database, and runs features.
//   const app = createStockman(deps);  app.use(feature);  await app.start();  ...  await app.stop();
// Every dependency can be passed in, so each layer is swappable or mocked:
//   deps = { env, dataDir, overrides, config, secrets, now, sleep, random,
//            log(fn, jarvis-style), bus (→ jarvis link), link, getConfig (jarvis config, so online.finance is honoured),
//            fetcher | fetch | http, provider, dbFile, openDbImpl }
//
// A FEATURE (how later phases plug in) is a plain object:
//   { id, migrations?: [{ version, name, up(raw) }], start?(ctx), stop?(ctx), tools?(ctx) → Tool[], health?() → object }
//   health(): a cheap, JSON-safe summary; app.health().dataQuality[id] carries it, and jarvis's status tool prints dataQuality.<id>.summary if a string.
//   id: lower case, unique. migrations: versions above the framework's, unique across features.
//   tools: names must start with "stockman_" (jarvis's tool registry is one flat namespace).
//   ctx = { db, events, stocks, link, log, config, secrets, now }
// The framework knows nothing about any feature: no feature code is imported here.
const { loadConfig } = require('./config');
const { createEnvSecrets } = require('./secrets');
const { createLogger, consoleSink, fromJarvisLog } = require('./log');
const { createRateLimiter, createBreaker, createGuard } = require('./resilience');
const { openStockmanDb } = require('./db');
const { createEventLog } = require('./db/events');
const { createStockService } = require('./stocks/service');
const { createYahooProvider, createFetcherHttp } = require('./stocks/yahoo');
const { createMockProvider } = require('./stocks/mock');
const { createBusLink, createMemoryLink } = require('./jarvis/link');
const { createStockmanTools } = require('./jarvis/tools');
const { ConfigError, StockmanError } = require('./errors');

const FRAMEWORK_VERSION = '1';   // written to meta on every start; bump when the framework contract changes
const FEATURE_ID = /^[a-z][a-z0-9-]{1,30}$/;

function buildProvider(config, deps) {
  if (deps.provider) return deps.provider;
  if (config.provider.name === 'mock') return createMockProvider({ now: deps.now });
  if (config.provider.name === 'yahoo') {
    let http = deps.http;
    if (!http) {
      let fetcher = deps.fetcher;
      if (!fetcher) {
        // jarvis's own fetcher and policy: https only, exact allowlisted host, timeout, size cap, stale cache. No second HTTP path.
        const { createFetcher } = require('../net/fetcher');
        const { createPolicy } = require('../net/policy');
        const getConfig = deps.getConfig || (() => ({ online: { enabled: true, finance: true } }));
        fetcher = createFetcher({ policy: createPolicy(getConfig), bus: deps.bus, cacheDir: config.cacheDir, timeoutMs: config.provider.timeoutMs, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      }
      http = createFetcherHttp({ fetcher });
    }
    return createYahooProvider({ http, now: deps.now });
  }
  throw new ConfigError(`unknown provider: ${config.provider.name}`);
}

function createStockman(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const config = deps.config || loadConfig({ env, dataDir: deps.dataDir, overrides: deps.overrides });
  const secrets = deps.secrets || createEnvSecrets({ env });
  let events = null, db = null, started = false, startedAt = null;
  const features = [];

  const logger = createLogger({
    level: config.log.level, eventLevel: config.log.eventLevel, now, name: 'app',
    sink: deps.log ? fromJarvisLog(deps.log) : consoleSink,
    eventSink: e => events?.append(e),
    secrets: () => secrets.values(),
  });
  const link = deps.link || (deps.bus ? createBusLink({ bus: deps.bus }) : createMemoryLink());

  const provider = buildProvider(config, deps);
  const p = config.provider;
  const limiter = createRateLimiter({ ratePerSec: p.ratePerSec, burst: p.burst, now, sleep: deps.sleep });
  const breaker = createBreaker({
    failures: p.breakerFailures, cooldownMs: p.breakerCooldownMs, now,
    onChange: c => {
      logger.child('breaker')[c.to === 'open' ? 'warn' : 'info'](`provider circuit ${c.from} → ${c.to}`, { failures: c.failures, lastError: c.lastError });
      try { link.publish('circuit', { provider: provider.name, state: c.to }); } catch { /* the link must not break the breaker */ }
    },
  });
  const guard = createGuard({ limiter, breaker, retries: p.retries, retryBaseMs: p.retryBaseMs, retryMaxMs: p.retryMaxMs, deadlineMs: p.deadlineMs, sleep: deps.sleep, random: deps.random, log: logger.child('stocks') });
  const stocks = createStockService({ provider, guard, log: logger.child('stocks'), now });

  const featureCtx = () => ({ db, events, stocks, link, log: null, config, secrets, now });

  const app = {
    config, stocks, link, secrets, log: logger,
    get db() { return db; },
    get events() { return events; },

    use(feature) {
      if (started) throw new StockmanError('app.use() must be called before start()');
      if (!feature || typeof feature !== 'object' || !FEATURE_ID.test(feature.id || '')) throw new TypeError('a feature needs an id: lower case letters, digits and dashes, 2 to 31 characters');
      if (features.some(f => f.id === feature.id)) throw new StockmanError(`feature "${feature.id}" is already registered`);
      for (const k of ['start', 'stop', 'tools', 'health']) if (feature[k] !== undefined && typeof feature[k] !== 'function') throw new TypeError(`feature "${feature.id}": ${k} must be a function`);
      features.push(feature);
      return app;
    },

    async start() {
      if (started) return app;
      if (!config.enabled) { logger.info('StockMan is switched off in config (enabled: false); not starting'); return app; }
      const migrations = features.flatMap(f => f.migrations || []);
      db = openStockmanDb({ file: deps.dbFile || config.dbPath, features: migrations, log: m => logger.error(m), ...(deps.openDbImpl ? { openDbImpl: deps.openDbImpl } : {}) });
      events = createEventLog(db, { now });
      const pruned = events.prune(config.db.eventRetentionDays);
      db.stmt('INSERT INTO meta(key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated').run('framework_version', FRAMEWORK_VERSION, now());
      db.stmt('INSERT OR IGNORE INTO meta(key, value, updated) VALUES (?, ?, ?)').run('created', String(now()), now());
      startedAt = now();
      const up = [];
      try {
        for (const f of features) {
          if (f.start) await f.start({ ...featureCtx(), log: logger.child(f.id) });
          up.push(f);
        }
      } catch (err) {
        logger.error('a feature failed to start; stopping what had started', { error: err.message });
        for (const f of up.reverse()) { try { await f.stop?.({ ...featureCtx(), log: logger.child(f.id) }); } catch { /* best effort */ } }
        db.close(); db = null; events = null;
        throw err;
      }
      started = true;
      logger.info('StockMan started', { schema: db.version, provider: provider.name, features: features.map(f => f.id), prunedEvents: pruned });
      try { link.publish('ready', { schema: db.version, provider: provider.name }); } catch (err) { logger.warn('could not tell jarvis StockMan is ready', { error: err.message }); }
      return app;
    },

    async stop() {
      if (!started) return;
      started = false;
      for (const f of [...features].reverse()) { try { await f.stop?.({ ...featureCtx(), log: logger.child(f.id) }); } catch (err) { logger.warn(`feature ${f.id} failed to stop`, { error: err.message }); } }
      try { link.publish('stopped'); } catch { /* jarvis may already be gone */ }
      logger.info('StockMan stopped');
      events = null;
      try { db.close(); } finally { db = null; }
    },

    health() {
      let dbOk = false, version = null;
      if (db) { try { db.stmt('SELECT 1').get(); dbOk = true; version = db.version; } catch { dbOk = false; } }
      // optional feature.health() → small JSON object, must be cheap (the worker pushes health every 5 s). One broken feature never breaks health.
      const dataQuality = {};
      for (const f of features) {
        if (!f.health) continue;
        try { dataQuality[f.id] = f.health(); } catch (err) { dataQuality[f.id] = { error: String(err.message).slice(0, 200) }; }
      }
      return {
        started, enabled: config.enabled, startedAt, link: link.name, dataQuality,
        db: db ? { ok: dbOk, version, file: db.file } : null,
        stocks: stocks.status(),
        features: features.map(f => f.id),
      };
    },

    // the jarvis tools: the framework's own plus each feature's (checked for the stockman_ prefix and for clashes)
    tools() {
      const out = [...createStockmanTools({ stockman: app })];
      for (const f of features) {
        if (!f.tools) continue;
        for (const t of f.tools({ ...featureCtx(), log: logger.child(f.id) })) {
          if (!/^stockman_[a-z0-9_]+$/.test(t?.name || '')) throw new StockmanError(`feature "${f.id}": tool names must start with "stockman_" (got ${JSON.stringify(t?.name)})`);
          if (out.some(o => o.name === t.name)) throw new StockmanError(`feature "${f.id}": tool "${t.name}" already exists`);
          out.push(t);
        }
      }
      return out;
    },
  };
  return app;
}

module.exports = { createStockman, FRAMEWORK_VERSION };
