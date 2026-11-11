// The ONLY way core code reaches the internet (spec §3). Every request: policy check before any socket,
// GET only, no cross-host redirects, 8 s timeout, 2 MB cap, TTL cache in memory + disk, 'net' bus event.
// Disk cache lets JARVIS answer "last known" when the network is down; such results carry stale + age.
// Budgets: the memory cache holds at most memMaxChars (least recently used go first, their disk copy stays);
// the disk cache drops files too old to be served and then the oldest ones over diskMaxBytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UA = 'JARVIS-core/0.1 (local assistant)';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const STALE_MAX_MS = 7 * 24 * 3600 * 1000;   // "last known" older than a week is not worth saying

const MEM_MAX_CHARS = 8 * 1024 * 1024;
const DISK_MAX_BYTES = 64 * 1024 * 1024;
const PRUNE_EVERY_MS = 3600 * 1000;
const CACHE_FILE = /^[0-9a-f]{40}\.json$/;    // only files this module wrote: on Windows <data>/cache is also Chromium's "Cache" folder

function createFetcher({ policy, fetch: doFetch = (...a) => globalThis.fetch(...a), bus, cacheDir, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, memMaxChars = MEM_MAX_CHARS, diskMaxBytes = DISK_MAX_BYTES }) {
  const mem = new Map();   // url -> { at, text }, least recently used first
  let memChars = 0, evicted = 0, lastPrune = 0;

  function remember(url, entry) {
    const old = mem.get(url);
    if (old) { mem.delete(url); memChars -= old.text.length; }
    if (entry.text.length > memMaxChars) return;   // larger than the whole budget: disk only
    mem.set(url, entry); memChars += entry.text.length;
    for (const [k, e] of mem) {
      if (memChars <= memMaxChars) break;
      mem.delete(k); memChars -= e.text.length; evicted++;
    }
  }

  // File times are wall-clock, so this uses Date.now() and not the injected clock.
  function pruneDisk() {
    if (!cacheDir || Date.now() - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = Date.now();
    try {
      const files = fs.readdirSync(cacheDir).filter(f => CACHE_FILE.test(f))
        .map(f => { const p = path.join(cacheDir, f), st = fs.statSync(p); return { p, at: st.mtimeMs, size: st.size }; })
        .sort((a, b) => b.at - a.at);
      let total = 0;
      for (const f of files) {
        total += f.size;
        if (Date.now() - f.at > STALE_MAX_MS || total > diskMaxBytes) fs.rmSync(f.p, { force: true });
      }
    } catch { /* cache is best effort */ }
  }
  const keyFile = url => cacheDir && path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex') + '.json');

  function readDisk(url) {
    const f = keyFile(url);
    if (!f) return null;
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.url === url ? { at: j.at, text: j.text } : null; } catch { return null; }
  }
  function writeDisk(url, entry) {
    const f = keyFile(url);
    if (!f) return;
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ url, at: entry.at, text: entry.text })); } catch { /* cache is best effort */ }
    pruneDisk();
  }
  const emit = p => { try { bus?.emit('net', p); } catch { /* listeners */ } };

  async function readCapped(res) {
    const len = Number(res.headers?.get?.('content-length'));
    if (len > maxBytes) throw new Error('response too large');
    if (!res.body?.getReader) { const t = await res.text(); if (Buffer.byteLength(t) > maxBytes) throw new Error('response too large'); return t; }
    const reader = res.body.getReader();
    const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) { try { await reader.cancel(); } catch { /* gone */ } throw new Error('response too large'); }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts).toString('utf8');
  }

  async function fetchOnce(source, url, headers) {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const a = policy.allowed(target, source);
      if (!a.ok) throw Object.assign(new Error(hop ? `redirect ${a.reason}` : a.reason), { code: 'REFUSED' });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
      const signal = ac.signal;
      let res;
      try {
        res = await doFetch(target, { method: 'GET', redirect: 'manual', signal, headers: { 'User-Agent': UA, Accept: 'application/json, application/xml, text/xml, text/html;q=0.8, */*;q=0.5', ...headers } });
      } catch (err) {
        clearTimeout(timer);
        if (signal.aborted) throw new Error(`timed out after ${timeoutMs / 1000} s`);
        throw new Error(`could not reach ${a.host}: ${err?.message || err}`);
      }
      if (res.status < 200 || res.status >= 300 || !res.ok) clearTimeout(timer);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`HTTP ${res.status} without location`);
        const next = new URL(loc, target).href;
        if (new URL(next).hostname !== new URL(target).hostname) throw Object.assign(new Error('redirect to another host refused'), { code: 'REFUSED' });
        target = next;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${a.host}`);
      try { return await readCapped(res); } catch (err) { if (signal.aborted) throw new Error(`timed out after ${timeoutMs / 1000} s`); throw err; } finally { clearTimeout(timer); }
    }
    throw new Error('too many redirects');
  }

  async function getText(source, url, { ttlMs = 0, headers = {} } = {}) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* reported by policy */ }
    const a = policy.allowed(url, source);
    if (!a.ok) { emit({ source, host, ok: false, ms: 0, cached: false, refused: true }); throw Object.assign(new Error(a.reason), { code: 'REFUSED' }); }
    const t = now();
    const hit = mem.get(url) || readDisk(url);
    if (hit && ttlMs > 0 && t - hit.at < ttlMs) {
      remember(url, hit);
      emit({ source, host, ok: true, ms: 0, cached: true, ageMs: t - hit.at });
      return { data: hit.text, cached: true, ageMs: t - hit.at };
    }
    const t0 = Date.now();
    try {
      const text = await fetchOnce(source, url, headers);
      const entry = { at: now(), text };
      remember(url, entry); writeDisk(url, entry);
      emit({ source, host, ok: true, ms: Date.now() - t0, cached: false, ageMs: 0 });
      return { data: text, cached: false, ageMs: 0 };
    } catch (err) {
      const ms = Date.now() - t0;
      if (err.code !== 'REFUSED' && hit && t - hit.at < STALE_MAX_MS) {
        emit({ source, host, ok: false, ms, cached: true, stale: true, ageMs: t - hit.at });
        return { data: hit.text, cached: true, stale: true, ageMs: t - hit.at, error: err.message };
      }
      emit({ source, host, ok: false, ms, cached: false, error: err.message });
      throw err;
    }
  }

  async function getJson(source, url, opts) {
    const r = await getText(source, url, opts);
    try { return { ...r, data: JSON.parse(r.data) }; } catch { throw new Error(`bad JSON from ${new URL(url).hostname}`); }
  }

  return {
    getText, getJson,
    stats: () => ({ entries: mem.size, chars: memChars, capChars: memMaxChars, evicted }),
    trim() { mem.clear(); memChars = 0; },   // under memory pressure: the disk copies still answer
  };
}

module.exports = { createFetcher, UA, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };
