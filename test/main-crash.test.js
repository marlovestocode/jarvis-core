const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installCrashHandlers } = require('../src/main/crash');

function setup(over = {}) {
  const proc = new EventEmitter();
  const logs = []; const calls = [];
  installCrashHandlers({
    proc,
    log: (...a) => logs.push(a.join(' ')),
    flush: over.flush || (() => { calls.push('flush'); }),
    exit: code => { calls.push(['exit', code]); },
  });
  return { proc, logs, calls };
}

test('uncaughtException logs the stack, flushes, and exits non-zero once', () => {
  const { proc, logs, calls } = setup();
  const err = new Error('boom');
  proc.emit('uncaughtException', err);
  assert.ok(logs.some(l => l.includes('uncaught exception') && l.includes(err.stack)));
  assert.deepEqual(calls, ['flush', ['exit', 1]]);
});

test('a second exception during shutdown does not recurse', () => {
  const state = { proc: null };
  const { proc, logs, calls } = setup({ flush: () => { state.proc.emit('uncaughtException', new Error('again')); } });
  state.proc = proc;
  proc.emit('uncaughtException', new Error('first'));
  assert.equal(calls.filter(c => Array.isArray(c) && c[0] === 'exit').length, 1);
  assert.ok(logs.some(l => l.includes('again')));
});

test('unhandledRejection is logged and does not exit', () => {
  const { proc, logs, calls } = setup();
  proc.emit('unhandledRejection', new Error('rej'));
  assert.ok(logs.some(l => l.includes('unhandled rejection') && l.includes('rej')));
  assert.deepEqual(calls, []);
});

test('a throwing flush still exits', () => {
  const { proc, calls } = setup({ flush: () => { throw new Error('flush fail'); } });
  proc.emit('uncaughtException', new Error('x'));
  assert.deepEqual(calls, [['exit', 1]]);
});
