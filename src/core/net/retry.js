// One way to retry and back off, for every local connection (Ollama, sysmon, the hosts' restarts).
//   backoff(attempt, { baseMs, maxMs, jitter, random }) → ms: base * 2^attempt, capped, with "full jitter" on the upper part
//   retry(fn, { retries, baseMs, maxMs, jitter, signal, shouldRetry, onRetry, sleep, random }) → fn's result
// fn(attempt) runs up to retries + 1 times. Only an error that shouldRetry accepts is retried (default: a refused or reset
// connection, a timeout, a fetch failure); an abort by the caller is never retried.
function backoff(attempt, { baseMs = 250, maxMs = 5000, jitter = 0.5, random = Math.random } = {}) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(raw * (1 - jitter) + raw * jitter * random());   // between raw*(1-jitter) and raw
}

const TRANSIENT = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|fetch failed|socket hang up|terminated|timed? ?out/i;
function isTransient(err) {
  if (!err || err.name === 'AbortError') return false;
  return TRANSIENT.test(`${err.code || ''} ${err.cause?.code || ''} ${err.message || ''}`);
}

const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function retry(fn, { retries = 2, baseMs = 250, maxMs = 5000, jitter = 0.5, signal, shouldRetry = isTransient, onRetry = () => {}, sleep = sleepMs, random = Math.random } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); } catch (err) {
      if (signal?.aborted || attempt >= retries || !shouldRetry(err)) throw err;
      const wait = backoff(attempt, { baseMs, maxMs, jitter, random });
      try { onRetry({ attempt: attempt + 1, wait, error: err }); } catch { /* a logger must not stop the retry */ }
      await sleep(wait, signal);
    }
  }
}

module.exports = { backoff, retry, isTransient };
