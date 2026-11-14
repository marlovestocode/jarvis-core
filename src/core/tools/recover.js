'use strict';
// Recovery policy: name what kind of failure a result is, then decide what to do about it. Pure functions; the caller (round.js
// attemptCall) performs the action through the exec path, so every retry is authorized again. The one rule that matters:
// a write that may have happened is never repeated, so only reads and idempotent tools are retried.

// errors a second try cannot fix (shared by the orchestrator and the task runner)
const NO_RETRY = /not running|not in Ollama|not allowed|must be local|timed out|aborted/i;
const UNAVAILABLE = /not connected|not running|unavailable|chrome extension|extension (?:is )?not/i;
const UNKNOWN_TOOL = /^Error: unknown tool/;
const TRANSIENT = /ECONN|ETIMEDOUT|EAI_AGAIN|HTTP 5\d\d|temporar|try again|rate limit|server busy|busy, try again/i;

function classify(res) {
  if (res?.ok) return 'ok';
  const text = String(res?.text ?? '');
  if (res?.denied) return 'denied';
  if (res?.badArgs) return 'bad_args';
  if (res?.timedOut) return 'timeout';
  // a ledger answer ("did not report back... try again") is a refusal, not a flaky call: never retry it
  if (res?.skipped) return 'fatal';
  if (/^Error: aborted/i.test(text)) return 'aborted';
  if (UNKNOWN_TOOL.test(text)) return 'unknown_tool';
  if (UNAVAILABLE.test(text)) return 'unavailable';
  if (TRANSIENT.test(text)) return 'transient';
  return 'fatal';
}

function plan(cls, { effect, idempotent, attempt = 0 } = {}) {
  const safe = (effect === 'read' || idempotent === true) && attempt === 0;
  switch (cls) {
    case 'ok': return 'accept';
    case 'transient': return safe ? 'retry' : 'stop';
    case 'timeout': return effect !== 'read' ? 'verify_or_unknown' : safe ? 'retry' : 'stop';   // even an idempotent write is verified, not retried
    case 'bad_args': return attempt === 0 ? 'repair' : 'stop';
    case 'unavailable': case 'unknown_tool': return 'rediscover';
    default: return 'stop';   // denied, aborted, fatal
  }
}

const backoffMs = attempt => Math.min(1000, 250 * 2 ** attempt);

module.exports = { NO_RETRY, classify, plan, backoffMs };
