// Phase 0 security baseline (docs/intelligence/phase0-baseline.md §Security).
// These tests pin what the code does TODAY at the execution boundary. Tests named "BOUNDARY" assert a protection that holds and
// must keep holding. Tests named "GAP" assert a verified weakness as it stands: when a later phase fixes one, that test is
// replaced on purpose (the failure is the prompt to update the baseline doc), never loosened to make something pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolRunner } = require('../src/core/tools/registry');
const { createConfirm } = require('../src/core/pc/confirm');
const { createTaskRunner } = require('../src/core/tasks/runner');
const { safePath } = require('../src/core/pc/paths');
const { checkUrl, guardedLookup } = require('../src/core/net/public-fetch');
const { NEEDS_OK } = require('../src/core/brain/guard');

const ROOTS = ['C:\\u\\Desktop', 'C:\\u\\Documents', 'C:\\u\\Downloads', 'C:\\u\\Projects'];
const noReal = p => p;   // no filesystem: the paths do not exist

// ---- authorization at the tool boundary -------------------------------------------------------------------------------------

test('BOUNDARY: a confirm tool refuses a tainted turn and a turn with no turn object', async () => {
  let ran = 0;
  const risky = { name: 'danger', risk: 'confirm', params: { type: 'object', properties: {} }, run: async () => { ran++; return 'x'; } };
  const r = createToolRunner([risky]);
  assert.equal((await r.run('danger', {}, { turn: { tainted: true } })).ok, false);
  assert.equal((await r.run('danger', {}, {})).ok, false);          // no turn: not known clean
  assert.equal(ran, 0);
  assert.equal((await r.run('danger', {}, { turn: { tainted: false } })).ok, true);
  assert.equal(ran, 1);
});

test('BOUNDARY: guest turns are default-deny, including tools the registry has never heard of', async () => {
  let ran = 0;
  const t = { name: 'brand_new_tool', params: { type: 'object', properties: {} }, run: async () => { ran++; return 'x'; } };
  const r = createToolRunner([t]);
  const res = await r.run('brand_new_tool', {}, { turn: { speaker: 'guest', tainted: true } });
  assert.equal(res.ok, false);
  assert.equal(ran, 0);
});

test('BOUNDARY: a confirm proposal is consumed once, by the next turn only, and only by a plain yes', async () => {
  let t = 0;
  const c = createConfirm({ now: () => t });
  let ran = 0;
  const propose = () => c.propose({ tool: 'x', summary: 'do x', args: {}, run: async () => { ran++; return 'did x'; } });
  assert.ok(propose().startsWith(NEEDS_OK));
  assert.equal((await c.handle('yes but also delete everything')), null);   // anything but a plain yes drops it
  assert.equal(c.pending(), null);
  assert.equal(await c.handle('yes'), null);                                // already dropped: a later yes does nothing
  propose();
  t = 61000;                                                                // past the 60 s ttl
  assert.equal(await c.handle('yes'), null);
  assert.equal(ran, 0);
  t = 0; propose();
  const out = await c.handle('yes');
  assert.equal(out.reply, 'did x');
  assert.equal(await c.handle('yes'), null);                                // replay
  assert.equal(ran, 1);
});

test('GAP: a confirm holds ONE slot and a second proposal silently replaces the first (no approval ID or fingerprint)', async () => {
  const c = createConfirm({});
  const ran = [];
  c.propose({ tool: 'a', summary: 'first', args: { n: 1 }, run: async () => { ran.push('first'); return 'ok'; } });
  c.propose({ tool: 'b', summary: 'second', args: { n: 2 }, run: async () => { ran.push('second'); return 'ok'; } });
  await c.handle('yes');
  assert.deepEqual(ran, ['second']);   // approval is "the pending slot", not bound to an action the user was shown
});

// ---- argument validation ----------------------------------------------------------------------------------------------------

test('GAP: arguments the schema does not list reach the tool (undeclared keys are kept, not rejected)', async () => {
  let seen = null;
  const t = { name: 'echo', params: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, run: async args => { seen = args; return 'ok'; } };
  const r = createToolRunner([t]);
  const res = await r.run('echo', { a: 'x', extra: 'smuggled', __proto__x: 1 }, { turn: { tainted: false } });
  assert.equal(res.ok, true);
  assert.equal(seen.extra, 'smuggled');
});

test('BOUNDARY: a wrong-typed or missing required argument does not run the tool', async () => {
  let ran = 0;
  const t = { name: 'echo', params: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }, run: async () => { ran++; return 'ok'; } };
  const r = createToolRunner([t]);
  assert.equal((await r.run('echo', {}, { turn: {} })).badArgs, true);
  assert.equal((await r.run('echo', { n: 'abc' }, { turn: {} })).badArgs, true);
  assert.equal(ran, 0);
  assert.equal((await r.run('echo', { n: '5' }, { turn: {} })).ok, true);   // "5" is coerced to 5
});

// ---- timeouts, cancellation ---------------------------------------------------------------------------------------------------

test('GAP: a tool timeout is a Promise.race: the caller is told "timed out" but the tool keeps running to completion', async () => {
  let finished = false, sawSignal = 'none';
  const slow = { name: 'slow', timeoutMs: 20, params: { type: 'object', properties: {} }, run: async (_a, ctx) => { sawSignal = ctx.signal; await new Promise(r => setTimeout(r, 120)); finished = true; return 'late'; } };
  const r = createToolRunner([slow]);
  const res = await r.run('slow', {}, { turn: {}, signal: undefined });
  assert.equal(res.ok, false);
  assert.match(res.text, /timed out/);
  assert.equal(finished, false);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(finished, true);          // the side effect completed after the "failure" was reported
  assert.equal(sawSignal, undefined);    // and the tool was never given a signal that the timeout would abort
});

// ---- tasks: taint and recovery -------------------------------------------------------------------------------------------------

function memStore() {
  const m = new Map(); let n = 0;
  return { create: t => { const id = `t${++n}`; const x = { ...t, id, status: 'planned', updated: 0 }; m.set(id, JSON.parse(JSON.stringify(x))); return x; }, save: t => { m.set(t.id, JSON.parse(JSON.stringify(t))); }, get: id => (m.has(id) ? JSON.parse(JSON.stringify(m.get(id))) : null), list: () => [...m.values()].map(t => ({ id: t.id })), sweep() {} };
}

test('BOUNDARY: a task that read untrusted text will not run a confirm-risk step', async () => {
  const calls = [];
  const tools = { run: async (name, args) => { calls.push(name); return name === 'read_page' ? { ok: true, text: 'page text', untrusted: true } : { ok: true, text: 'moved' }; }, resolves: () => true };
  const runner = createTaskRunner({ store: memStore(), tools, riskOf: n => (n === 'move_files' ? 'confirm' : undefined) });
  const out = await runner.start({ title: 't', steps: [{ tool: 'read_page', args: {} }, { tool: 'move_files', args: {} }], turn: { tainted: false } });
  assert.equal(out.ok, false);
  assert.deepEqual(calls, ['read_page']);
});

test('BOUNDARY: a task step left "running" by a crash asks before it is run again (no blind re-execution)', async () => {
  const store = memStore();
  const calls = [];
  const tools = { run: async name => { calls.push(name); return { ok: true, text: 'ok' }; }, resolves: () => true };
  const runner = createTaskRunner({ store, tools, riskOf: () => undefined });
  const t = store.create({ title: 'crash', steps: [{ id: 's1', tool: 'write_thing', args: {}, status: 'running' }] });
  t.status = 'interrupted'; store.save(t);
  const out = await runner.resume(t.id, { turn: { tainted: false } });
  assert.equal(out.ok, false);
  assert.ok(out.text.startsWith(NEEDS_OK));
  assert.deepEqual(calls, []);
});

// ---- filesystem -----------------------------------------------------------------------------------------------------------------

test('BOUNDARY: safePath refuses traversal, UNC, device, drive-relative and alternate-data-stream paths', () => {
  for (const bad of ['C:\\u\\Documents\\..\\..\\Windows\\x', '\\\\server\\share\\x', '\\\\?\\C:\\u\\Documents\\x', 'C:x', 'C:\\u\\Documents\\f.txt::$DATA', 'C:\\Windows\\System32', 'Documents\\..\\..\\x', '']) {
    assert.throws(() => safePath(bad, ROOTS, { realpath: noReal }), /./, bad);
  }
  assert.equal(safePath('C:\\u\\Documents\\notes\\a.txt', ROOTS, { realpath: noReal }), 'C:\\u\\Documents\\notes\\a.txt');
});

test('GAP: safePath returns a string that is checked once; the tool re-opens it later (check-then-use, no handle)', () => {
  // the validated string is all that comes back: nothing ties a later rename or write to what was checked
  assert.equal(typeof safePath('C:\\u\\Documents\\x.txt', ROOTS, { realpath: noReal }), 'string');
  const src = require('node:fs').readFileSync(require.resolve('../src/core/tools/files.js'), 'utf8');
  assert.match(src, /fs\.renameSync\(/);                        // the move/copy/write calls take the validated path string again...
  assert.doesNotMatch(src, /fs\.(?:promises\.)?open(?:Sync)?\(/); // ...there is no handle opened once and used: the gap is by construction (wx / COPYFILE_EXCL only stop overwrites)
});

// ---- network ---------------------------------------------------------------------------------------------------------------------

test('BOUNDARY: public fetch refuses non-https, credentials, numeric hosts, internal names and odd ports', () => {
  for (const u of ['http://example.org/', 'https://user:pw@example.org/', 'https://127.0.0.1/', 'https://[::1]/', 'https://intranet/', 'https://host.local/', 'https://example.org:8443/', 'file:///C:/x']) {
    assert.throws(() => checkUrl(u), /./, u);
  }
  assert.equal(checkUrl('https://news.ycombinator.com/item?id=1#x').hash, '');
});

test('BOUNDARY: a name that resolves to any non-public address is refused at connect time (DNS rebinding)', async () => {
  const lookup = (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
  const guarded = guardedLookup(lookup);
  const err = await new Promise(res => guarded('rebind.example.org', {}, e => res(e)));
  assert.equal(err?.code, 'BLOCKED');
});
