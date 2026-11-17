// Failure handling for any outside call: rate limit, circuit breaker, retry with backoff, overall deadline.
// Retry and backoff are jarvis's own (src/core/net/retry.js); this file adds what it lacks. The clock and sleep are injected so tests need no real time.
const { retry } = require('../net/retry');
const { CircuitOpenError, DeadlineError, StockmanError } = require('./errors');

const realSleep = ms => new Promise(r => setTimeout(r, ms));

// Token bucket: `burst` tokens, refilled at `ratePerSec`. acquire() waits until a token is free, so callers queue and never spike.
function createRateLimiter({ ratePerSec = 5, burst = 2, now = Date.now, sleep = realSleep } = {}) {
  let tokens = burst, last = now(), pauseUntil = 0;
  const waiting = [];   // callers are served in order
  let running = false;

  function refill() {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec);
    last = t;
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (waiting.length) {
        const t = now();
        if (t < pauseUntil) { await sleep(pauseUntil - t); continue; }
        refill();
        if (tokens >= 1) { tokens -= 1; waiting.shift()(); continue; }
        await sleep(Math.max(1, Math.ceil(((1 - tokens) / ratePerSec) * 1000)));
      }
    } finally { running = false; }
  }
  return {
    acquire: () => new Promise(resolve => { waiting.push(resolve); pump(); }),
    // the provider said "slow down": nothing is released for ms, whatever the bucket holds
    penalize(ms) { pauseUntil = Math.max(pauseUntil, now() + Math.max(0, ms)); tokens = 0; },
    state: () => { refill(); return { tokens: Math.floor(tokens * 100) / 100, queued: waiting.length, pausedMs: Math.max(0, pauseUntil - now()) }; },
  };
}

// Circuit breaker: closed → open after `failures` in a row → half-open after `cooldownMs` (one probe) → closed on success.
function createBreaker({ failures = 5, cooldownMs = 30000, now = Date.now, onChange = () => {} } = {}) {
  let state = 'closed', count = 0, openedAt = 0, probing = false, lastError = null;
  const set = next => { if (next !== state) { const prev = state; state = next; try { onChange({ from: prev, to: next, failures: count, lastError }); } catch { /* listener */ } } };
  return {
    // throws CircuitOpenError when the call should not be tried
    beforeCall() {
      if (state === 'open') {
        if (now() - openedAt < cooldownMs) throw new CircuitOpenError(`provider circuit open, retry in ${Math.ceil((cooldownMs - (now() - openedAt)) / 1000)} s${lastError ? ` (last error: ${lastError})` : ''}`);
        set('half-open'); probing = false;
      }
      if (state === 'half-open') {
        if (probing) throw new CircuitOpenError('provider circuit half-open, a probe is already running');
        probing = true;
      }
    },
    success() { count = 0; probing = false; lastError = null; set('closed'); },
    // only failures that say the provider is unhealthy count (errors.js countsForBreaker); a missing symbol does not
    failure(err) {
      if (!(err instanceof StockmanError) || !err.countsForBreaker) { probing = false; return; }
      count += 1; lastError = err.message; probing = false;
      if (state === 'half-open' || count >= failures) { openedAt = now(); set('open'); }
    },
    // a call that ended without telling us about provider health (not found, bad request) frees a half-open probe
    neutral() { probing = false; },
    state: () => ({ state, consecutiveFailures: count, lastError, reopensInMs: state === 'open' ? Math.max(0, cooldownMs - (now() - openedAt)) : 0 }),
  };
}

// withDeadline(fn(signal), ms): rejects with DeadlineError after ms; the signal is aborted so a cooperative fn can stop.
function withDeadline(fn, ms, label = 'call') {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const e = new DeadlineError(`${label} did not finish within ${ms} ms`); ac.abort(e); reject(e); }, ms); });
  return Promise.race([Promise.resolve().then(() => fn(ac.signal)), timeout]).finally(() => clearTimeout(timer));
}

// createGuard: one function that runs `fn` with all four protections.
//   guard.run(label, fn(attempt, signal)) → result
// Order: breaker check, then (inside the deadline) rate limit + attempt, retried on retryable errors with backoff.
function createGuard({ limiter, breaker, retries = 2, retryBaseMs = 250, retryMaxMs = 5000, deadlineMs = 30000, sleep = realSleep, random = Math.random, log, onRetry = () => {} } = {}) {
  return {
    limiter, breaker,
    async run(label, fn) {
      breaker.beforeCall();
      try {
        const result = await withDeadline(signal => retry(async attempt => {
          if (signal.aborted) throw signal.reason;
          await limiter.acquire();
          return fn(attempt, signal);
        }, {
          retries, baseMs: retryBaseMs, maxMs: retryMaxMs, signal, sleep, random,
          shouldRetry: err => err instanceof StockmanError && err.retryable,
          onRetry: info => {
            if (info.error?.code === 'RATE_LIMIT') limiter.penalize(info.wait);
            log?.warn(`${label}: attempt ${info.attempt} failed, retrying in ${info.wait} ms`, { error: info.error?.message, code: info.error?.code });
            onRetry(info);
          },
        }), deadlineMs, label);
        breaker.success();
        return result;
      } catch (err) {
        breaker.failure(err);
        throw err;
      }
    },
  };
}

module.exports = { createRateLimiter, createBreaker, createGuard, withDeadline };
