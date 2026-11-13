const test = require('node:test');
const assert = require('node:assert/strict');
const { isUntrustedTool } = require('../src/core/brain/guard');
const guard = require('../src/core/brain/guard');
const { createKnowledgeTools } = require('../src/core/tools/knowledge');
const { createPcTools } = require('../src/core/tools/pc');
const { buildCatalog } = require('../src/core/skills');

const FORMER = ['lookup_knowledge', 'read_article', 'news_headlines', 'get_weather', 'weather_alerts', 'sports_scores', 'find_files', 'list_windows'];

function catalog() {
  const k = createKnowledgeTools({ fetcher: {}, kiwix: {}, getConfig: () => ({}) });
  const p = createPcTools({ host: {}, getAllowlist: async () => ({}), roots: [], confirm: {}, actionLog: {} });
  return buildCatalog([{ id: 'knowledge', tools: k }, { id: 'pc', tools: p }]);
}

test('every tool in the former UNTRUSTED_TOOLS set carries untrusted:true', () => {
  const cat = catalog();
  for (const n of FORMER) {
    assert.equal(cat.byName.get(n)?.tool?.untrusted, true, n);
    assert.equal(isUntrustedTool(n, cat), true, n);
  }
  assert.equal(guard.UNTRUSTED_TOOLS, undefined, 'the hardcoded set is gone');
});

test('isUntrustedTool is false for unknown names', () => {
  const cat = catalog();
  assert.equal(isUntrustedTool('no_such_tool', cat), false);
  assert.equal(isUntrustedTool('list_windows', null), false);
  assert.equal(isUntrustedTool('list_windows', undefined), false);
});
