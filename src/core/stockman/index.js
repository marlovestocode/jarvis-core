// StockMan backend framework (phase one). Entry point: createStockman(deps) in ./app.js. Layers:
//   config.js / secrets.js / log.js   configuration, secrets from the environment, redacting logger
//   resilience.js                     rate limit, circuit breaker, retry, deadline
//   db/                               stockman.db: connection, migrations, engine_event log
//   stocks/                           StockProvider port, Yahoo adapter, mock, service
//   jarvis/                           the jarvis link port and the framework's read-only tools
module.exports = {
  ...require('./app'),
  ...require('./errors'),
  loadConfig: require('./config').loadConfig,
  openStockmanDb: require('./db').openStockmanDb,
  createEventLog: require('./db/events').createEventLog,
  createStockService: require('./stocks/service').createStockService,
  createYahooProvider: require('./stocks/yahoo').createYahooProvider,
  createFetcherHttp: require('./stocks/yahoo').createFetcherHttp,
  createMockProvider: require('./stocks/mock').createMockProvider,
  assertProvider: require('./stocks/provider').assertProvider,
  createBusLink: require('./jarvis/link').createBusLink,
  createMemoryLink: require('./jarvis/link').createMemoryLink,
  createStockmanTools: require('./jarvis/tools').createStockmanTools,
  createLogger: require('./log').createLogger,
  createEnvSecrets: require('./secrets').createEnvSecrets,
  ...require('./resilience'),
};
