// Online Wikipedia (REST): the fallback when the offline library is missing or has nothing.
// Only the search words or article title go out. Cached 7 days.
const { stripHtml, decodeEntities } = require('./feed-parser');

const SEARCH = 'https://en.wikipedia.org/w/rest.php/v1/search/page';
const REST = 'https://en.wikipedia.org/api/rest_v1/page/';
const TTL = 7 * 24 * 3600 * 1000;
const titlePath = t => encodeURIComponent(String(t).trim().replace(/ /g, '_')).replace(/%2F/g, '/');
const notFound = err => /HTTP 404/.test(err.message);

async function searchWikiOnline(fetcher, q, limit = 5) {
  const r = await fetcher.getJson('wiki', `${SEARCH}?q=${encodeURIComponent(String(q).trim())}&limit=${limit}`, { ttlMs: TTL });
  return (r.data?.pages || []).map(p => ({ title: p.title, snippet: decodeEntities(stripHtml(p.excerpt || '')), description: p.description || '' }));
}

async function summaryOnline(fetcher, title) {
  let r;
  try { r = await fetcher.getJson('wiki', REST + 'summary/' + titlePath(title), { ttlMs: TTL }); } catch (err) { if (notFound(err)) return null; throw err; }
  const d = r.data || {};
  if (!d.title || d.type === 'not_found') return null;
  return {
    title: d.title, extract: d.extract || '', url: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${titlePath(d.title)}`,
    updated: d.timestamp || '', disambiguation: d.type === 'disambiguation', description: d.description || '',
    ageMs: r.ageMs, stale: !!r.stale,
  };
}

// search → best title → summary (skipping a disambiguation page when a real article is listed)
async function lookupOnline(fetcher, q) {
  const hits = await searchWikiOnline(fetcher, q);
  if (!hits.length) return null;
  const best = hits.find(h => !/\(disambiguation\)/i.test(h.title)) || hits[0];
  return summaryOnline(fetcher, best.title);
}

async function articleHtmlOnline(fetcher, title) {
  let r;
  try { r = await fetcher.getText('wiki', REST + 'html/' + titlePath(title), { ttlMs: TTL }); } catch (err) { if (notFound(err)) return null; throw err; }
  return { title, html: r.data, ageMs: r.ageMs, stale: !!r.stale };
}

module.exports = { searchWikiOnline, summaryOnline, lookupOnline, articleHtmlOnline };
