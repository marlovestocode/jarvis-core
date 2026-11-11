// A cortex for tests: cortexOn(dir) opens <dir>/cortex.db (a file path means its folder); reopening the folder sees what was saved.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../../src/core/cortex');

function cortexOn(p = fs.mkdtempSync(path.join(os.tmpdir(), 'jcortex-')), opts = {}) {
  const dir = /\.\w+$/.test(path.basename(p)) ? path.dirname(p) : p;
  fs.mkdirSync(dir, { recursive: true });
  return open({ file: path.join(dir, 'cortex.db'), ...opts });
}

module.exports = { cortexOn };
