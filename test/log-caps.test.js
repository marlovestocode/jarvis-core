// Every append-only file JARVIS writes stays bounded no matter how long it runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActionLog } = require('../src/core/pc/actions-log');
const { createWebAudit } = require('../src/core/web/audit');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-caps-'));
const lines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

test('actions log stays at or under LIMIT entries after 10x LIMIT writes', () => {
  const file = path.join(tmp(), 'actions.log');
  const log = createActionLog({ file });
  const LIMIT = log.stats().cap;
  for (let i = 0; i < LIMIT * 10; i++) log.write({ what: 'x', args: { i }, result: 'ok', ok: true });
  assert.ok(log.list().length <= LIMIT, `memory holds ${log.list().length}`);
  assert.ok(lines(file).length <= LIMIT, `disk holds ${lines(file).length}`);
  assert.equal(JSON.parse(lines(file).pop()).args.i, LIMIT * 10 - 1, 'the newest entry survives');
});

test('web-activity.jsonl stays bounded: one moved-aside generation, never more', () => {
  const dir = tmp(), file = path.join(dir, 'web-activity.jsonl');
  const maxBytes = 4096;
  const audit = createWebAudit({ file, maxBytes });
  for (let i = 0; i < 2000; i++) audit.record({ kind: 'search', query: 'q' + i, ok: true });
  const size = f => fs.statSync(f).size;
  const oneEntry = 300;   // an entry is far smaller than this
  assert.ok(size(file) <= maxBytes + oneEntry, `live file is ${size(file)} bytes`);
  assert.ok(size(file + '.1') <= maxBytes + oneEntry, 'the old generation is bounded too');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['web-activity.jsonl', 'web-activity.jsonl.1']);
});
