// General web access, held to a short list of rules. This is NOT the allowlisted fetcher (net/fetcher.js): it may reach
// any public site, so everything that makes that safe is enforced here, at connect time, not just by looking at the URL.
//   - https only, port 443, no credentials in the URL, no IP-address hosts, no local or internal names
//   - the address a name RESOLVES to must be public; the check runs inside the socket's own lookup, so a name that
//     answers with 127.0.0.1 or 192.168.x.x (or changes its answer between a check and the connection) is refused
//   - every redirect hop goes through the same checks; at most 3
//   - GET only; no cookies, no login headers, a plain User-Agent; the body is read with a hard size cap and only text-like
//     content is accepted (a download is never saved or run)
//   - a total time limit
// get(url) → { status, url, contentType, text, bytes, ms }; errors carry code BLOCKED (with the reason), HTTP or NETWORK.
const https = require('node:https');
const dns = require('node:dns');
const zlib = require('node:zlib');
const net = require('node:net');
const { isPublicIp } = require('./public-ip');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS-core/0.1 (+local assistant; reads pages for the user)';
const TEXTUAL = /^(?:text\/(?:html|plain|xml)|application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))\b/i;
const INTERNAL_NAME = /(?:^|\.)(?:localhost|local|internal|lan|home|corp|intranet|private|localdomain|onion|i2p|test|invalid|example)$/i;

const blocked = reason => Object.assign(new Error(reason), { code: 'BLOCKED' });

// → URL object, or throws BLOCKED
function checkUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw blocked('that is not a usable web address');
  let u;
  try { u = new URL(input.trim()); } catch { throw blocked('that is not a valid web address'); }
  if (u.protocol !== 'https:') throw blocked('only https pages are opened');
  if (u.username || u.password) throw blocked('addresses with a login in them are refused');
  if (u.port && u.port !== '443') throw blocked('only the standard https port is used');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) throw blocked('that is not a valid web address');
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw blocked('addresses made of numbers are refused');
  if (!host.includes('.') || INTERNAL_NAME.test(host)) throw blocked('local and internal names are refused');
  u.hash = '';
  return u;
}

// dns.lookup replacement used by the socket: only public addresses come back
function guardedLookup(lookup) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = (Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }]);
      const ok = list.filter(a => isPublicIp(a.address));
      if (!ok.length || ok.length !== list.length) return cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'BLOCKED' }));
      if (options?.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}

function createPublicFetch({ request = https.request, lookup = dns.lookup, timeoutMs = 10000, maxBytes = 1.5 * 1024 * 1024, maxRedirects = 3, now = Date.now } = {}) {
  const guarded = guardedLookup(lookup);

  function once(u, { accept, cap, deadline }) {
    return new Promise((resolve, reject) => {
      const left = deadline - now();
      if (left <= 0) return reject(Object.assign(new Error('timed out'), { code: 'NETWORK' }));
      let done = false;
      const fail = err => { if (done) return; done = true; clearTimeout(timer); try { req.destroy(); } catch { /* gone */ } reject(err); };
      const ok = v => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => fail(Object.assign(new Error('timed out'), { code: 'NETWORK' })), left);
      const req = request({
        protocol: 'https:', hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET', agent: false, lookup: guarded,
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en', 'Accept-Encoding': 'gzip, deflate', 'Cache-Control': 'no-cache' },
      }, res => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return ok({ redirect: new URL(res.headers.location, u).href, status }); }
        const type = String(res.headers['content-type'] || '');
        if (status < 200 || status >= 300) { res.resume(); return fail(Object.assign(new Error(`HTTP ${status} from ${u.hostname}`), { code: 'HTTP', status })); }
        if (!TEXTUAL.test(type)) { res.resume(); return fail(blocked(`that is not a readable page (${type.split(';')[0] || 'unknown type'}); downloads are never fetched`)); }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > cap * 8) { res.resume(); return fail(blocked('that page is too large')); }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc && enc !== 'identity') { res.resume(); return fail(blocked(`unsupported encoding ${enc}`)); }
        const chunks = [];
        let n = 0;
        stream.on('data', c => {
          n += c.length;
          if (n > cap) { chunks.push(c.subarray(0, c.length - (n - cap))); n = cap; stream.destroy(); ok(finish(true)); return; }
          chunks.push(c);
        });
        stream.on('end', () => ok(finish(false)));
        stream.on('error', err => { if (!done) fail(Object.assign(err, { code: err.code || 'NETWORK' })); });
        const finish = truncated => {
          const charset = /charset=([\w-]+)/i.exec(type)?.[1]?.toLowerCase();
          const label = charset && /^(?:utf-?8|iso-8859-1|latin1|windows-1252|ascii)$/.test(charset) ? (charset === 'latin1' ? 'iso-8859-1' : charset) : 'utf-8';
          return { status, contentType: type.split(';')[0].trim().toLowerCase(), text: new TextDecoder(label, { fatal: false }).decode(Buffer.concat(chunks)), bytes: n, truncated };
        };
      });
      req.on('error', err => fail(err.code === 'BLOCKED' ? blocked(err.message) : Object.assign(new Error(`could not reach ${u.hostname}: ${err.message}`), { code: 'NETWORK' })));
      req.end();
    });
  }

  async function get(url, { accept = 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1', maxBytes: cap = maxBytes } = {}) {
    const t0 = now();
    const deadline = t0 + timeoutMs;
    let u = checkUrl(url);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const r = await once(u, { accept, cap, deadline });
      if (r.redirect) { u = checkUrl(r.redirect); continue; }
      return { status: r.status, url: u.href, contentType: r.contentType, text: r.text, bytes: r.bytes, truncated: r.truncated, ms: now() - t0 };
    }
    throw blocked('too many redirects');
  }

  return { get, checkUrl };
}

module.exports = { createPublicFetch, checkUrl, guardedLookup };
