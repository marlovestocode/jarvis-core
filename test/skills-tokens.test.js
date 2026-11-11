const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { createToolRunner } = require('../src/core/tools/registry');
const { route } = require('../src/core/brain/router');
const { toolDeps } = require('./helpers/tool-deps');
const manifest = require('./fixtures/tool-manifest.json');
const golden = require('./fixtures/route-golden.json');

test("tokens: selected specs are at least 60% smaller than today's flat list", t => {
  const catalog = buildCatalog(loadGroups(toolDeps()));
  const runner = createToolRunner(catalog.tools, { groups: catalog.groups });
  const baseline = JSON.stringify(manifest.map(({ name, description, params }) => ({ name, description, params }))).length;
  const sizes = [];
  for (const row of golden) {
    if (route(row.text, { source: 'text' }).tier !== 'deep') continue;
    const ids = selectGroups(row.text, { lastGroups: row.lastGroups || [], source: 'text' }, catalog);
    sizes.push(JSON.stringify(runner.turn(ids).specs()).length);
  }
  assert.ok(sizes.length >= 30, `only ${sizes.length} deep rows`);
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  t.diagnostic(`flat ${baseline} chars; selected mean ${Math.round(mean)} chars over ${sizes.length} deep turns; reduction ${(100 - 100 * mean / baseline).toFixed(1)}%`);
  assert.ok(mean <= 0.4 * baseline, `mean ${Math.round(mean)} > 40% of ${baseline}`);
});
