// How big the tool specs sent to the model are: the flat list of today (the pre-migration manifest) against the
// groups selected per deep turn of the golden table. Used by test/skills-tokens.test.js and eval/spec-tokens.js.
const { loadGroups, buildCatalog } = require('../../src/core/skills');
const { selectGroups } = require('../../src/core/skills/select');
const { createToolRunner } = require('../../src/core/tools/registry');
const { route } = require('../../src/core/brain/router');
const { toolDeps } = require('./tool-deps');
const manifest = require('../fixtures/tool-manifest.json');
const golden = require('../fixtures/route-golden.json');

function measureSpecs() {
  const catalog = buildCatalog(loadGroups(toolDeps()));
  const runner = createToolRunner(catalog.tools, { groups: catalog.groups });
  const baseline = JSON.stringify(manifest.map(({ name, description, params }) => ({ name, description, params }))).length;
  const sizes = [], counts = [];
  for (const row of golden) {
    if (route(row.text, { source: 'text' }).tier !== 'deep') continue;
    const ids = selectGroups(row.text, { lastGroups: row.lastGroups || [], source: 'text' }, catalog);
    const specs = runner.turn(ids).specs();
    sizes.push(JSON.stringify(specs).length);
    counts.push(specs.length);
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { baseline, baselineTools: manifest.length, turns: sizes.length, meanChars: mean(sizes), meanTools: mean(counts), reduction: 1 - mean(sizes) / baseline };
}

module.exports = { measureSpecs };
