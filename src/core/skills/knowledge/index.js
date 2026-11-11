const { createKnowledgeTools } = require('../../tools/knowledge');
const { FACT } = require('../../brain/router');
const { own } = require('../util');

const ALIASES = {
  get_weather: ['weather'],
  news_headlines: ['get_news'],
  lookup_knowledge: ['wikipedia', 'search'],
};

function createGroup({ fetcher, kiwix, getConfig, bus, knowledge = null } = {}) {
  const tools = fetcher ? createKnowledgeTools({ fetcher, kiwix, getConfig, bus, knowledge }) : [];
  // online lookups can be switched off; the offline library still answers facts when it is installed
  const status = () => (getConfig?.()?.online?.enabled !== false ? { ok: true, detail: 'online lookups on' } : kiwix?.available?.() === true ? { ok: true, detail: 'online lookups off, offline library only' } : { ok: false, detail: 'online lookups are off and there is no offline library' });
  return { status, id: 'knowledge', label: 'Facts, Wikipedia, weather, news and sports scores', triggers: [
    { words: ['weather', 'forecast', 'rain', 'snow', 'news', 'headlines', 'score', 'scores', 'standings'], w: 3 },
    { re: FACT, w: 1 },   // a bare question word is not enough on its own: no match falls back to knowledge anyway
  ], tools: tools.map(t => own(t, ALIASES[t.name] || [], { untrusted: true })) };
}

module.exports = { createGroup };
