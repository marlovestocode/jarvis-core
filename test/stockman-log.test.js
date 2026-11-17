const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, fromJarvisLog } = require('../src/core/stockman/log');

test('stockman-log: level filter, child names and field formatting', () => {
  const lines = [];
  const log = createLogger({ level: 'info', sink: l => lines.push(l), now: () => 0 });
  log.debug('hidden');
  log.child('stocks').warn('slow', { ms: 5 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /WARN\s+stockman\.core\.stocks slow {"ms":5}/);
});

test('stockman-log: secrets are redacted in message and fields before any sink', () => {
  const lines = [], rows = [];
  const log = createLogger({ level: 'debug', sink: l => lines.push(l), eventSink: e => rows.push(e), secrets: () => ['test-value-1234'], now: () => 0 });
  log.error('call to https://h/?k=test-value-1234 failed', { token: 'zzz', note: 'test-value-1234' });
  assert.ok(!lines[0].includes('test-value-1234') && !lines[0].includes('zzz'));
  assert.ok(!JSON.stringify(rows).includes('test-value-1234'));
  assert.equal(rows[0].data.token, '[redacted]');
});

test('stockman-log: event sink gets only lines at or above eventLevel, even when the console level is higher', () => {
  const rows = [];
  const log = createLogger({ level: 'error', eventLevel: 'warn', sink: () => {}, eventSink: e => rows.push(e.level), now: () => 0 });
  log.info('a'); log.warn('b'); log.error('c');
  assert.deepEqual(rows, ['warn', 'error']);
});

test('stockman-log: a throwing sink never breaks the caller', () => {
  const log = createLogger({ sink: () => { throw new Error('disk full'); }, eventSink: () => { throw new Error('db locked'); }, now: () => 0 });
  assert.doesNotThrow(() => log.error('x'));
  assert.doesNotThrow(() => fromJarvisLog(() => { throw new Error('log gone'); })('line'));
});
