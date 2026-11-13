const test = require('node:test');
const assert = require('node:assert/strict');
const { toolDeps } = require('./helpers/tool-deps');
const { loadGroups, buildCatalog } = require('../src/core/skills');

test('every tool parameter has a non-empty description', () => {
  const cat = buildCatalog(loadGroups(toolDeps()));
  const offenders = [];
  const walk = (tool, schema, p) => {
    for (const [k, v] of Object.entries((schema && schema.properties) || {})) {
      const name = `${p}${k}`;
      if (typeof v.description !== 'string' || !v.description.trim()) offenders.push(`${tool}.${name}`);
      if (v.type === 'object') walk(tool, v, `${name}.`);
      if (v.items && v.items.type === 'object') walk(tool, v.items, `${name}[].`);
    }
  };
  for (const t of cat.tools) walk(t.name, t.params, '');
  assert.deepEqual(offenders, [], `parameters without a description:\n${offenders.join('\n')}`);
});
