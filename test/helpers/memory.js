// A cortex-backed memory for tests: memoryOn(dirOrFile) opens <dir>/cortex.db (a .json path means its folder)
// and returns createMemory({ cortex }). Reopening the same folder sees what was saved.
const path = require('node:path');
const { open } = require('../../src/core/cortex');
const { createMemory } = require('../../src/core/memory/facts');

function memoryOn(p, opts = {}) {
  const dir = /\.json$/i.test(p) ? path.dirname(p) : p;
  const cortex = open({ file: path.join(dir, 'cortex.db') });
  const memory = createMemory({ cortex, ...opts });
  memory.cortex = cortex;
  return memory;
}

module.exports = { memoryOn };
