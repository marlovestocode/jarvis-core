// DuckDuckGo's HTML results page, no account or key. It is an unofficial surface, so the parser is small and strict:
// anything it cannot read gives zero results rather than a guess, and a human-check page is reported as such.
const { decodeEntities } = require('./readable');

const SEARCH = 'https://html.duckduckgo.com/html/?q=';
const searchUrl = q => SEARCH + encodeURIComponent(String(q).trim());

const tagless = s => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// result links go through DuckDuckGo's redirector: the real address is its uddg parameter
function realUrl(href) {
  const h = decodeEntities(href);
  try {
    const u = new URL(h.startsWith('//') ? 'https:' + h : h, 'https://duckduckgo.com');
    if (u.hostname === 'duckduckgo.com' && u.pathname === '/l/') return u.searchParams.get('uddg') || null;
    if (u.hostname === 'duckduckgo.com') return null;   // DuckDuckGo's own pages and ads are not results
    return u.href;
  } catch { return null; }
}

function isHumanCheck(html) {
  return /anomaly-modal|unfortunately, bots use duckduckgo|select all squares|are you a human/i.test(html) && !/result__a/.test(html);
}

// → [{ title, url, host, snippet }]
function parseResults(html, max = 8) {
  const out = [];
  const seen = new Set();
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1);
  for (const b of blocks) {
    if (/result--ad\b|result__badge/.test(b.slice(0, 300))) continue;
    const a = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b) || /<a[^>]+href="([^"]+)"[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = realUrl(a[1]);
    if (!url || !/^https:\/\//i.test(url)) continue;
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    const key = host + new URL(url).pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    const sn = /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b) || /<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
    out.push({ title: tagless(a[2]).slice(0, 160), url, host, snippet: sn ? tagless(sn[1]).slice(0, 300) : '' });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { searchUrl, parseResults, isHumanCheck, realUrl };
