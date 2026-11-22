// StockMan framework errors. One class per way a call can fail, so callers decide by kind and not by message text.
//   retryable: the same call may work if tried again later (the resilience layer retries only these)
//   countsForBreaker: the failure says the provider is unhealthy (a missing symbol does not)
class StockmanError extends Error {
  constructor(message, { code = 'STOCKMAN', retryable = false, countsForBreaker = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
    this.countsForBreaker = countsForBreaker;
  }
}

class ConfigError extends StockmanError { constructor(m, o) { super(m, { code: 'CONFIG', ...o }); } }
class MigrationError extends StockmanError { constructor(m, o) { super(m, { code: 'MIGRATION', ...o }); } }
class InvalidRequestError extends StockmanError { constructor(m, o) { super(m, { code: 'INVALID_REQUEST', ...o }); } }
class NotFoundError extends StockmanError { constructor(m, o) { super(m, { code: 'NOT_FOUND', ...o }); } }
// the jarvis network policy refused the host or the source is switched off: retrying cannot help
class PolicyError extends StockmanError { constructor(m, o) { super(m, { code: 'POLICY', ...o }); } }
class RateLimitError extends StockmanError { constructor(m, o) { super(m, { code: 'RATE_LIMIT', retryable: true, countsForBreaker: true, ...o }); } }
class TransientError extends StockmanError { constructor(m, o) { super(m, { code: 'TRANSIENT', retryable: true, countsForBreaker: true, ...o }); } }
// the provider answered but the body is not what the adapter expects (the unofficial endpoint changed, or bad data)
class ProviderDataError extends StockmanError { constructor(m, o) { super(m, { code: 'PROVIDER_DATA', countsForBreaker: true, ...o }); } }
class CircuitOpenError extends StockmanError { constructor(m, o) { super(m, { code: 'CIRCUIT_OPEN', ...o }); } }
class DeadlineError extends StockmanError { constructor(m, o) { super(m, { code: 'DEADLINE', retryable: true, countsForBreaker: true, ...o }); } }

module.exports = {
  StockmanError, ConfigError, MigrationError, InvalidRequestError, NotFoundError, PolicyError,
  RateLimitError, TransientError, ProviderDataError, CircuitOpenError, DeadlineError,
};
