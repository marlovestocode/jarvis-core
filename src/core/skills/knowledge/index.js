const { createKnowledgeTools } = require('../../tools/knowledge');
const { FACT } = require('../../brain/router');
const { own } = require('../util');

const ALIASES = {
  get_weather: ['weather'],
  news_headlines: ['get_news'],
  lookup_knowledge: ['wikipedia', 'search'],
};

function createGroup({ fetcher, kiwix, getConfig, bus } = {}) {
  const tools = fetcher ? createKnowledgeTools({ fetcher, kiwix, getConfig, bus }) : [];
  // online lookups can be switched off; the offline library still answers facts when it is installed
  const status = () => (getConfig?.()?.online?.enabled !== false ? { ok: true, detail: 'online lookups on' } : kiwix?.available?.() === true ? { ok: true, detail: 'online lookups off, offline library only' } : { ok: false, detail: 'online lookups are off and there is no offline library' });
  return { status, id: 'knowledge', label: 'Facts, Wikipedia, weather, news and sports scores', triggers: [
    { re: /\b(?:(?:storm|severe|tornado|flood|heat|winter|weather) (?:warnings?|alerts?|watch(?:es)?|advisor(?:y|ies))|how (?:hot|cold|warm) is it|is it (?:hot|cold|warm|freezing) (?:out|outside))\b/i, w: 3 },
    { words: ['weather', 'forecast', 'rain', 'snow', 'news', 'headlines', 'score', 'scores', 'standings'], w: 3 },
    { re: FACT, w: 1 },   // a bare question word is not enough on its own: no match falls back to knowledge anyway
  ], tools: tools.map(t => own(t, ALIASES[t.name] || [], { untrusted: true })) };
}

module.exports = { createGroup };
