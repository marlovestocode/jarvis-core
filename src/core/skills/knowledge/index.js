const { createKnowledgeTools } = require('../../tools/knowledge');
const { FACT } = require('../../brain/router');
const { own } = require('../util');

const ALIASES = {
  get_weather: ['weather'],
  news_headlines: ['get_news'],
  lookup_knowledge: ['wikipedia', 'search', 'web_search'],
};

function createGroup({ fetcher, kiwix, getConfig, bus } = {}) {
  const tools = fetcher ? createKnowledgeTools({ fetcher, kiwix, getConfig, bus }) : [];
  return { id: 'knowledge', label: 'Facts, Wikipedia, weather, news and sports scores', triggers: [
    { words: ['weather', 'forecast', 'rain', 'snow', 'news', 'headlines', 'score', 'scores', 'standings'], w: 3 },
    { re: FACT, w: 1 },   // a bare question word is not enough on its own: no match falls back to knowledge anyway
  ], tools: tools.map(t => own(t, ALIASES[t.name] || [], { untrusted: true })) };
}

module.exports = { createGroup };
