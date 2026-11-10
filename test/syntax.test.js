// The Electron side has no unit tests of its own; at least make sure every file parses,
// so a typo can never leave a hidden app stuck on an error dialog at Windows sign-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dirs = ['src/main', 'src/ui', 'src/core'];
const files = dirs.flatMap(d => {
  const walk = p => fs.readdirSync(p, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(p, e.name)) : e.name.endsWith('.js') ? [path.join(p, e.name)] : []));
  return walk(path.join(__dirname, '..', d));
});

test('every source file parses', () => {
  assert.ok(files.length > 30);
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (err) { assert.fail(`${path.relative(process.cwd(), f)}: ${String(err.stderr).split('\n').slice(0, 4).join(' ')}`); }
  }
});
