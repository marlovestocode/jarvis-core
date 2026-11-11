// What JARVIS may do on the open web, and the limits on it. Two operations only:
//   search(query)  a DuckDuckGo search; the query is checked first (no personal details, no secrets)
//   open(url)      read one page; ONLY an address a search returned in the last hour (so JARVIS cannot be steered to an
//                  address a page invented, and it never fetches a URL built from your data)
// Both are counted (30 each per ten minutes), refused when web access is off in settings, and written to the audit log with
// the reason when refused. Results are text for the model to quote: the tools mark them untrusted, so a turn that read the
// web cannot start an action that needs your yes or change what JARVIS remembers.
const { searchUrl, parseResults, isHumanCheck } = require('./ddg');
const { htmlToText } = require('./readable');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const SEEN_TTL_MS = 60 * 60 * 1000;
const SEEN_MAX = 300;
const QUERY_MAX = 200;

const SECRET = /\b(?:password|passcode|passphrase|api[\s_-]?key|secret key|private key|token|cvv|ssn|social security|seed phrase)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const LONG_DIGITS = /(?:\d[\s.-]?){9,}/;   // phone and card numbers, account numbers
const URL_WITH_QUERY = /https?:\/\/\S+[?#]\S*/i;

const refuse = (reason, code = 'REFUSED') => Object.assign(new Error(reason), { code });

function createWeb({ publicFetch, audit, getConfig = () => ({}), now = Date.now } = {}) {
  const calls = { search: [], open: [] };
  const seen = new Map();   // url without fragment → time a search returned it

  const enabled = () => { const o = getConfig()?.online || {}; return o.enabled !== false && o.web !== false; };
  const norm = u => String(u).trim().replace(/#.*$/, '');

  function limit(kind) {
    const t = now();
    const list = calls[kind];
    while (list.length && t - list[0] > WINDOW_MS) list.shift();
    if (list.length >= MAX_PER_WINDOW) throw refuse(`web ${kind === 'search' ? 'searches' : 'page reads'} are limited to ${MAX_PER_WINDOW} every ten minutes; that limit has been reached`);
    list.push(t);
  }

  // the user's own details never go out in a search
  function checkQuery(raw) {
    const q = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (q.length < 2) throw refuse('a search needs a few words');
    if (q.length > QUERY_MAX) throw refuse(`a search is limited to ${QUERY_MAX} characters`);
    if (EMAIL.test(q)) throw refuse('an email address is never put in a web search');
    if (LONG_DIGITS.test(q)) throw refuse('long numbers (phone, card, account) are never put in a web search');
    if (SECRET.test(q)) throw refuse('passwords, keys and tokens are never put in a web search');
    if (URL_WITH_QUERY.test(q)) throw refuse('a web address with its own query is not a search');
    const cfg = getConfig() || {};
    const name = String(cfg.user?.name || '').trim();
    if (name.split(/\s+/).length >= 2 && q.toLowerCase().includes(name.toLowerCase())) throw refuse("the user's full name is never put in a web search");
    return q;
  }

  async function search(query) {
    let q = String(query ?? '').trim();
    const base = { tool: 'web_search', query: q.slice(0, 200) };
    try {
      if (!enabled()) throw refuse('web search is switched off in settings');
      q = checkQuery(q);
      limit('search');
    } catch (err) { audit?.record({ ...base, ok: false, blocked: err.message }); throw err; }
    const t0 = now();
    try {
      const r = await publicFetch.get(searchUrl(q), { maxBytes: 600 * 1024 });
      if (isHumanCheck(r.text)) throw refuse('the search provider asked for a human check, so it could not be searched right now', 'NETWORK');
      const results = parseResults(r.text);
      const t = now();
      for (const x of results) seen.set(norm(x.url), t);
      if (seen.size > SEEN_MAX) for (const k of [...seen.keys()].slice(0, seen.size - SEEN_MAX)) seen.delete(k);
      audit?.record({ ...base, q, ok: true, results: results.length, hosts: [...new Set(results.map(x => x.host))].slice(0, 8), bytes: r.bytes, ms: now() - t0 });
      return results;
    } catch (err) {
      audit?.record({ ...base, ok: false, blocked: err.code === 'BLOCKED' ? err.message : undefined, error: err.code === 'BLOCKED' ? undefined : err.message, ms: now() - t0 });
      throw err;
    }
  }

  async function open(url, { maxChars = 20000 } = {}) {
    const target = norm(url);
    const base = { tool: 'web_open', url: target.slice(0, 300) };
    try {
      if (!enabled()) throw refuse('web access is switched off in settings');
      const at = seen.get(target);
      if (at === undefined || now() - at > SEEN_TTL_MS) throw refuse('only a page that a search just returned can be opened; search first');
      limit('open');
    } catch (err) { audit?.record({ ...base, ok: false, blocked: err.message }); throw err; }
    const t0 = now();
    try {
      const r = await publicFetch.get(target);
      const page = r.contentType.includes('html') || r.contentType.includes('xml') ? htmlToText(r.text, { maxChars }) : { title: '', text: r.text.slice(0, maxChars) };
      let host = '';
      try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { /* checked by the fetch */ }
      audit?.record({ ...base, ok: true, host, finalUrl: r.url !== target ? r.url : undefined, status: r.status, bytes: r.bytes, chars: page.text.length, ms: now() - t0 });
      return { title: page.title, url: r.url, host, text: page.text, truncated: r.truncated };
    } catch (err) {
      audit?.record({ ...base, ok: false, blocked: err.code === 'BLOCKED' ? err.message : undefined, error: err.code === 'BLOCKED' ? undefined : err.message, ms: now() - t0 });
      throw err;
    }
  }

  return { search, open, enabled, checkQuery, seenCount: () => seen.size };
}

module.exports = { createWeb, MAX_PER_WINDOW };
