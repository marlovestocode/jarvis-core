// The local services JARVIS talks to, defined once: where they are, whether an address is allowed, and how to ask "are you up".
// Ollama (the model) and sysmon (live hardware stats) used to be spelled out in five places with different timeouts and error text.
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const OLLAMA = 'http://127.0.0.1:11434';
const SYSMON = 'http://127.0.0.1:47800';

// the configured address without a trailing slash, or null when it is not this PC (a model host must never be remote)
function localOrigin(raw, fallback = OLLAMA) {
  const h = String(raw || fallback).trim().replace(/\/+$/, '');
  return LOCAL_ORIGIN.test(h) ? h : null;
}

// true when sysmon answers its health check within ms
async function sysmonUp(fetchImpl = globalThis.fetch, ms = 1000) {
  try { const r = await Promise.resolve(fetchImpl(`${SYSMON}/health`, { signal: AbortSignal.timeout(ms) })); return !!r?.ok; } catch { return false; }
}

module.exports = { LOCAL_ORIGIN, OLLAMA, SYSMON, localOrigin, sysmonUp };
