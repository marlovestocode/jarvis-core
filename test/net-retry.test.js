const test = require('node:test');
const assert = require('node:assert/strict');
const { backoff, retry, isTransient } = require('../src/core/net/retry');

test('backoff doubles, is capped, and jitter stays inside its band', () => {
  const o = { baseMs: 100, maxMs: 1000, jitter: 0.5 };
  assert.equal(backoff(0, { ...o, random: () => 1 }), 100);
  assert.equal(backoff(0, { ...o, random: () => 0 }), 50);
  assert.equal(backoff(2, { ...o, random: () => 1 }), 400);
  assert.equal(backoff(10, { ...o, random: () => 1 }), 1000);
  for (let i = 0; i < 200; i++) { const v = backoff(3, o); assert.ok(v >= 400 && v <= 800, String(v)); }
});

test('retry: retries only transient errors, then returns', async () => {
  let n = 0; const waits = [];
  const out = await retry(async () => { if (++n < 3) throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }); return 'ok'; },
    { retries: 3, baseMs: 10, jitter: 0, sleep: ms => { waits.push(ms); return Promise.resolve(); } });
  assert.equal(out, 'ok'); assert.equal(n, 3); assert.deepEqual(waits, [10, 20]);
});

test('retry: a plain error, an abort and the retry limit all stop at once', async () => {
  let n = 0;
  await assert.rejects(retry(async () => { n++; throw new Error('HTTP 404'); }, { sleep: async () => {} }), /404/);
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(retry(async () => { n++; throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); }, { retries: 2, sleep: async () => {} }), /x/);
  assert.equal(n, 3, 'first try plus two retries');
  const ac = new AbortController(); ac.abort();
  n = 0;
  await assert.rejects(retry(async () => { n++; throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); }, { signal: ac.signal, sleep: async () => {} }));
  assert.equal(n, 1);
});

test('isTransient: connection trouble yes, abort and HTTP errors no', () => {
  assert.equal(isTransient(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(isTransient(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isTransient(new Error('Ollama HTTP 500')), false);
});
