const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig, DEFAULTS } = require('../src/core/stockman/config');
const { ConfigError } = require('../src/core/stockman/errors');
const { createEnvSecrets, createStaticSecrets, redact } = require('../src/core/stockman/secrets');

const noFile = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const dir = path.resolve('/tmp/stockman-test');

test('stockman-config: defaults when there is no file or env', () => {
  const c = loadConfig({ env: {}, dataDir: dir, readFile: noFile });
  assert.equal(c.provider.name, 'yahoo');
  assert.equal(c.provider.retries, DEFAULTS.provider.retries);
  assert.equal(c.dbPath, path.join(dir, 'stockman.db'));
  assert.equal(c.source, 'defaults');
  assert.ok(Object.isFrozen(c));
});

test('stockman-config: layers apply in order file < env < overrides', () => {
  const readFile = () => JSON.stringify({ provider: { retries: 4, name: 'mock' }, log: { level: 'debug' } });
  const c = loadConfig({ env: { STOCKMAN_PROVIDER: 'yahoo' }, dataDir: dir, readFile, overrides: { log: { level: 'warn' } } });
  assert.equal(c.provider.retries, 4);        // from file
  assert.equal(c.provider.name, 'yahoo');     // env beats file
  assert.equal(c.log.level, 'warn');          // overrides beat both
});

test('stockman-config: data dir comes from STOCKMAN_DATA_DIR, then JARVIS_DATA_DIR', () => {
  assert.equal(loadConfig({ env: { JARVIS_DATA_DIR: dir }, readFile: noFile }).dataDir, dir);
  const other = path.resolve('/tmp/other');
  assert.equal(loadConfig({ env: { JARVIS_DATA_DIR: dir, STOCKMAN_DATA_DIR: other }, readFile: noFile }).dataDir, other);
});

test('stockman-config: a wrong value is an error, not a fallback', () => {
  assert.throws(() => loadConfig({ env: {}, dataDir: dir, readFile: noFile, overrides: { provider: { retries: 99 } } }), ConfigError);
  assert.throws(() => loadConfig({ env: { STOCKMAN_PROVIDER: 'nope' }, dataDir: dir, readFile: noFile }), /provider\.name/);
  assert.throws(() => loadConfig({ env: { STOCKMAN_ENABLED: 'maybe' }, dataDir: dir, readFile: noFile }), /true or false/);
  assert.throws(() => loadConfig({ env: {}, dataDir: dir, readFile: noFile, overrides: { db: { file: '../x.db' } } }), /db\.file/);
  assert.throws(() => loadConfig({ env: {}, dataDir: dir, readFile: noFile, overrides: { provider: { retryBaseMs: 5000, retryMaxMs: 100 } } }), /retryMaxMs/);
});

test('stockman-config: broken JSON and unreadable file are errors; a missing file is fine', () => {
  assert.throws(() => loadConfig({ env: {}, dataDir: dir, readFile: () => '{nope' }), /not valid JSON/);
  assert.throws(() => loadConfig({ env: {}, dataDir: dir, readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /cannot read/);
  assert.doesNotThrow(() => loadConfig({ env: {}, dataDir: dir, readFile: noFile }));
});

test('stockman-config: a secret-looking key in the file is refused', () => {
  const fake = 'not-a-real-value';
  assert.throws(() => loadConfig({ env: {}, dataDir: dir, readFile: () => JSON.stringify({ apiKey: fake }) }), /looks like a secret/);
  assert.throws(() => loadConfig({ env: {}, dataDir: dir, readFile: () => JSON.stringify({ provider: { token: fake } }) }), /looks like a secret/);
});

test('stockman-secrets: env provider reads STOCKMAN_<NAME> only and remembers values for redaction', () => {
  const s = createEnvSecrets({ env: { STOCKMAN_DEMO_KEY: 'test-value-1234', OTHER: 'x' } });
  assert.equal(s.get('DEMO_KEY'), 'test-value-1234');
  assert.equal(s.get('OTHER'), undefined);
  assert.equal(s.has('MISSING'), false);
  assert.deepEqual(s.values(), ['test-value-1234']);
  assert.throws(() => s.get('bad name'), /bad secret name/);
});

test('stockman-secrets: redact masks secret-looking keys and known secret values, deeply', () => {
  const out = redact({ url: 'https://h/x?k=test-value-1234', apiKey: 'abc', nested: { Authorization: 'Bearer z', fine: 1 }, list: ['test-value-1234'] }, ['test-value-1234']);
  assert.equal(out.url, 'https://h/x?k=[redacted]');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.nested.Authorization, '[redacted]');
  assert.equal(out.nested.fine, 1);
  assert.deepEqual(out.list, ['[redacted]']);
  assert.deepEqual(createStaticSecrets({ A: 'v' }).values(), ['v']);
});
