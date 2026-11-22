const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, createBreaker, createGuard, withDeadline } = require('../src/core/stockman/resilience');
const E = require('../src/core/stockman/errors');

// a clock that only moves when something sleeps, so no test waits in real time
function fakeTime(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } };
}

test('stockman-resilience: rate limiter lets a burst through, then paces at ratePerSec', async () => {
  const time = fakeTime();
  const lim = createRateLimiter({ ratePerSec: 2, burst: 2, now: time.now, sleep: time.sleep });
  const t0 = time.now();
  const stamps = [];
  for (let i = 0; i < 5; i++) { await lim.acquire(); stamps.push(time.now() - t0); }
  assert.deepEqual(stamps.slice(0, 2), [0, 0]);                 // the burst
  assert.ok(stamps[4] >= 1400 && stamps[4] <= 1600, `5th call at ${stamps[4]} ms`);   // 3 more tokens at 2/s ≈ 1.5 s
});

test('stockman-resilience: penalize holds everything back for the given time', async () => {
  const time = fakeTime();
  const lim = createRateLimiter({ ratePerSec: 100, burst: 5, now: time.now, sleep: time.sleep });
  lim.penalize(2000);
  const t0 = time.now();
  await lim.acquire();
  assert.ok(time.now() - t0 >= 2000);
});

test('stockman-resilience: breaker opens after N counted failures, fails fast, probes after the cooldown, closes on success', () => {
  const time = fakeTime();
  const changes = [];
  const b = createBreaker({ failures: 3, cooldownMs: 1000, now: time.now, onChange: c => changes.push(c.to) });
  for (let i = 0; i < 3; i++) { b.beforeCall(); b.failure(new E.TransientError('down')); }
  assert.equal(b.state().state, 'open');
  assert.throws(() => b.beforeCall(), E.CircuitOpenError);
  time.advance(1001);
  b.beforeCall();                                                // the probe
  assert.throws(() => b.beforeCall(), /probe is already running/);   // only one at a time
  b.success();
  assert.equal(b.state().state, 'closed');
  assert.deepEqual(changes, ['open', 'half-open', 'closed']);
});

test('stockman-resilience: a failed probe reopens the circuit; errors that are not the provider\'s fault never count', () => {
  const time = fakeTime();
  const b = createBreaker({ failures: 2, cooldownMs: 1000, now: time.now });
  b.beforeCall(); b.failure(new E.NotFoundError('x'));
  b.beforeCall(); b.failure(new E.InvalidRequestError('x'));
  b.beforeCall(); b.failure(new Error('plain'));
  assert.equal(b.state().consecutiveFailures, 0);
  b.failure(new E.RateLimitError('x')); b.failure(new E.RateLimitError('x'));
  assert.equal(b.state().state, 'open');
  time.advance(1001);
  b.beforeCall();
  b.failure(new E.TransientError('still down'));
  assert.equal(b.state().state, 'open');
});

function makeGuard(over = {}) {
  const time = fakeTime();
  const limiter = createRateLimiter({ ratePerSec: 1000, burst: 100, now: time.now, sleep: time.sleep });
  const breaker = createBreaker({ failures: 3, cooldownMs: 1000, now: time.now });
  const waits = [];
  const sleep = async ms => { waits.push(ms); time.advance(ms); };
  const guard = createGuard({ limiter, breaker, retries: 2, retryBaseMs: 100, retryMaxMs: 1000, deadlineMs: 5000, sleep, random: () => 1, ...over });
  return { guard, breaker, limiter, waits, time };
}

test('stockman-resilience: guard retries retryable errors with growing backoff and then succeeds', async () => {
  const { guard, waits, breaker } = makeGuard();
  let n = 0;
  const out = await guard.run('t', async attempt => { n++; if (attempt < 2) throw new E.TransientError('blip'); return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(n, 3);
  assert.deepEqual(waits, [100, 200]);   // base * 2^attempt, jitter pinned
  assert.equal(breaker.state().consecutiveFailures, 0);
});

test('stockman-resilience: guard gives up after the retry budget and counts one failure for the breaker', async () => {
  const { guard, breaker } = makeGuard();
  let n = 0;
  await assert.rejects(guard.run('t', async () => { n++; throw new E.TransientError('down'); }), E.TransientError);
  assert.equal(n, 3);   // 1 + 2 retries
  assert.equal(breaker.state().consecutiveFailures, 1);
});

test('stockman-resilience: guard never retries a non-retryable error (not found, policy, bad data)', async () => {
  for (const Err of [E.NotFoundError, E.PolicyError, E.ProviderDataError]) {
    const { guard } = makeGuard();
    let n = 0;
    await assert.rejects(guard.run('t', async () => { n++; throw new Err('no'); }), Err);
    assert.equal(n, 1, Err.name);
  }
});

test('stockman-resilience: a rate-limit answer pauses the limiter', async () => {
  const { guard, limiter } = makeGuard();
  let paused = 0;
  const orig = limiter.penalize.bind(limiter);
  limiter.penalize = ms => { paused = ms; orig(ms); };
  let n = 0;
  await guard.run('t', async () => { n++; if (n === 1) throw new E.RateLimitError('429'); return 1; });
  assert.ok(paused > 0);
});

test('stockman-resilience: an open circuit rejects without calling the provider', async () => {
  const { guard } = makeGuard({ retries: 0 });
  for (let i = 0; i < 3; i++) await guard.run('t', async () => { throw new E.TransientError('down'); }).catch(() => {});
  let called = false;
  await assert.rejects(guard.run('t', async () => { called = true; }), E.CircuitOpenError);
  assert.equal(called, false);
});

test('stockman-resilience: withDeadline rejects slow work and aborts its signal', async () => {
  let aborted = false;
  await assert.rejects(withDeadline(signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }), 30, 'slow'), E.DeadlineError);
  assert.equal(aborted, true);
  assert.equal(await withDeadline(async () => 7, 1000), 7);
});
