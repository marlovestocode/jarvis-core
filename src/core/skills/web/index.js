const { createWebTools } = require('../../tools/web');
const { own } = require('../util');

const ALIASES = {
  web_search: ['search_web', 'internet_search', 'google', 'search_internet', 'browse_web', 'duckduckgo'],
  web_open: ['open_page', 'read_webpage', 'fetch_url', 'open_url', 'read_url', 'visit_page'],
};

function createGroup({ web, getConfig } = {}) {
  const tools = web ? createWebTools({ web }) : [];
  const status = () => (web?.enabled() ? { ok: true, detail: 'web search on' } : { ok: false, detail: 'web search is off in settings' });
  return {
    status,
    id: 'web',
    label: 'Search the web and read the pages it finds',
    triggers: [
      { re: /\b(?:search|google|look|browse|find)\b.{0,40}\b(?:web|online|internet)\b|\b(?:web|internet|online) search\b|\bsearch (?:for|up)\b|\bgoogle\b|\bduckduckgo\b|\blook (?:it |that |this )?up\b/i, w: 3 },
      { words: ['latest', 'recent', 'breaking', 'trending', 'release date', 'reviews', 'price of', 'how much does', 'who won', 'is it true'], w: 1 },
    ],
    tools: tools.map(t => own(t, ALIASES[t.name] || [], { untrusted: true })),
  };
}

module.exports = { createGroup };
