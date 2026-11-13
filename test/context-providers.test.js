const test = require('node:test');
const assert = require('node:assert/strict');
const { liveProvider, taskProvider, memoryProvider } = require('../src/core/context/providers');
const { createAssembler } = require('../src/core/context/assemble');

const NOW = 1_000_000;
const now = () => NOW;
const live = (snap) => ({ snapshot: () => snap });

test('live: window app, timers, media items with exact shape', async () => {
  const p = liveProvider({ live: live({ activeWindow: { app: 'Code' }, media: { playing: true }, timers: { count: 2, nextInMs: 45000 } }), now });
  assert.equal(p.name, 'livestate');
  const items = await p.fetch({});
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(by).sort(), ['live:media', 'live:timers', 'live:window']);
  for (const i of items) {
    assert.equal(i.kind, 'state'); assert.equal(i.source, 'livestate'); assert.equal(i.observedAt, NOW); assert.equal(i.trust, 'owner');
    assert.equal(typeof i.confidence, 'number');
  }
  assert.equal(by['live:window'].sensitivity, 'personal'); assert.equal(by['live:window'].topic, 'window');
  assert.equal(by['live:timers'].text, '2 timers running, next in 45 sec'); assert.equal(by['live:timers'].topic, 'timers');
  assert.equal(by['live:media'].topic, 'media');
  assert.equal(by['live:window'].query, 'Code');
  assert.equal('query' in by['live:timers'], false); assert.equal('query' in by['live:media'], false);
});

test('live: title only when present, private and untrusted', () => {
  const none = liveProvider({ live: live({ activeWindow: { app: 'Code' } }), now }).fetch({});
  assert.equal(none.some((i) => i.id === 'live:title'), false);
  const t = liveProvider({ live: live({ activeWindow: { app: 'Code', title: 'secret.txt' } }), now }).fetch({}).find((i) => i.id === 'live:title');
  assert.equal(t.sensitivity, 'private'); assert.equal(t.trust, 'untrusted'); assert.ok(t.text.includes('secret.txt'));
});

test('live: timers wording and rounding; one timer; no timers; confirm excluded', () => {
  const f = (timers) => liveProvider({ live: live({ timers, confirm: { summary: 'wire money' } }), now }).fetch({});
  assert.equal(f({ count: 1, nextInMs: 5 * 60000 })[0].text, '1 timer running, next in 5 min');
  assert.equal(f({ count: 3, nextInMs: 3 * 3600000 })[0].text, '3 timers running, next in 3 h');
  assert.equal(f({ count: 1 })[0].text, '1 timer running');
  assert.deepEqual(f({ count: 0 }), []);
  assert.ok(!JSON.stringify(f({ count: 1 })).includes('wire money'));
});

test('live: media not playing yields no item; missing or throwing live yields []', async () => {
  assert.deepEqual(liveProvider({ live: live({ media: { playing: false } }), now }).fetch({}), []);
  assert.deepEqual(await liveProvider({ now }).fetch({}), []);
  assert.deepEqual(await liveProvider({ live: { snapshot() { throw new Error('x'); } }, now }).fetch({}), []);
  assert.deepEqual(await liveProvider({ live: live(null), now }).fetch({}), []);
});

test('tasks: active task item, clipped, null observedAt', () => {
  const p = taskProvider({ tasks: { active: () => ({ id: 't1', title: 'Write report', status: 'running', done: 1, total: 3 }) }, now });
  assert.equal(p.name, 'tasks');
  const [i] = p.fetch({});
  assert.deepEqual(i, { id: 'task:t1', text: 'Task "Write report" is running (1/3 steps done)', source: 'tasks', kind: 'task', observedAt: null, confidence: 0.8, trust: 'owner', sensitivity: 'personal', topic: 'task', query: 'Write report' });
  const [long] = taskProvider({ tasks: { active: () => ({ id: 't2', title: 'x'.repeat(500), status: 'running', done: 0, total: 1 }) }, now }).fetch({});
  assert.ok(long.text.length <= 160);
});

test('tasks: none, missing and throwing deps give []', () => {
  assert.deepEqual(taskProvider({ tasks: { active: () => null }, now }).fetch({}), []);
  assert.deepEqual(taskProvider({ now }).fetch({}), []);
  assert.deepEqual(taskProvider({ tasks: { active() { throw new Error('x'); } }, now }).fetch({}), []);
});

const block = (memo, ids) => ({ calls: [], async forTurn(a) { this.calls.push(a); return { memo, ids }; } });

test('memory: lines after header become memory items with ids', async () => {
  const b = block('Relevant from memory (x):\n- likes tea [fact · 2d]\n- lives in Oslo [chat · 1w]', ['a', 'b']);
  const p = memoryProvider({ block: b, getSessionId: () => 's1' });
  assert.equal(p.name, 'cortex');
  const items = await p.fetch({ text: 'hi', brief: true, context: 'ctx' });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.id), ['mem:a', 'mem:b']);
  for (const i of items) { assert.equal(i.kind, 'memory'); assert.equal(i.source, 'cortex'); assert.equal(i.observedAt, null); assert.equal(i.confidence, 0.6); assert.equal(i.sensitivity, 'personal'); assert.equal(i.trust, 'owner'); }
  assert.equal(items[0].text, 'likes tea');
  assert.equal(b.calls[0].sessionId, 's1'); assert.equal(b.calls[0].brief, true); assert.equal(b.calls[0].context, 'ctx');
});

test('memory: no context in request means none passed; empty memo, blank lines, throw give []', async () => {
  const b = block('H\n\n- one [f · 1d]', ['a']);
  const items = await memoryProvider({ block: b }).fetch({ text: 'q' });
  assert.equal(items.length, 1);
  assert.equal('context' in b.calls[0] && b.calls[0].context !== undefined, false);
  assert.deepEqual(await memoryProvider({ block: block('', []) }).fetch({ text: 'q' }), []);
  assert.deepEqual(await memoryProvider({ block: { forTurn: async () => { throw new Error('x'); } } }).fetch({ text: 'q' }), []);
  assert.deepEqual(await memoryProvider({ block: { forTurn() { throw new Error('x'); } } }).fetch({ text: 'q' }), []);
  assert.deepEqual(await memoryProvider({}).fetch({ text: 'q' }), []);
});

test('through the real assembler: nothing invalid, title never reaches hint', async () => {
  const snap = { activeWindow: { app: 'Code', title: 'TOPSECRET.txt' }, media: { playing: true }, timers: { count: 1, nextInMs: 60000 } };
  const asm = createAssembler({ now, providers: [
    liveProvider({ live: live(snap), now }),
    taskProvider({ tasks: { active: () => ({ id: 't', title: 'Plan', status: 'running', done: 0, total: 2 }) }, now }),
    memoryProvider({ block: block('H\n- likes tea [fact · 2d]', ['a']) }),
  ] });
  const r = await asm.assemble({ text: 'hello', allowPrivate: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.dropped.filter((d) => d.reason === 'invalid').length, 0);
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['live:media', 'live:timers', 'live:title', 'live:window', 'mem:a', 'task:t']);
  assert.ok(!r.hint.includes('TOPSECRET'));
  assert.ok(r.hint.includes('Code')); assert.ok(r.text.includes('TOPSECRET'));
});

test('live: request.snap is used instead of a second live.snapshot()', async () => {
  let calls = 0;
  const l = { snapshot: () => { calls++; return { activeWindow: { app: 'Old' } }; } };
  const p = liveProvider({ live: l, now });
  const viaSnap = await p.fetch({ snap: { activeWindow: { app: 'Code' } } });
  assert.equal(calls, 0); assert.equal(viaSnap[0].query, 'Code');
  const fallback = await p.fetch({});
  assert.equal(calls, 1); assert.equal(fallback[0].query, 'Old');
});

test('tasks: request.snap.task is used instead of tasks.active(); fallback when no snap', async () => {
  let calls = 0;
  const p = taskProvider({ tasks: { active: () => { calls++; return { id: 'a', title: 'Fallback', status: 'running' }; } }, now });
  const [i] = await p.fetch({ snap: { task: { id: 't9', title: 'From snap', status: 'paused', done: 1, total: 2 } } });
  assert.equal(calls, 0); assert.equal(i.id, 'task:t9'); assert.equal(i.query, 'From snap');
  assert.deepEqual(await p.fetch({ snap: {} }), []); assert.equal(calls, 0);
  const [f] = await p.fetch({});
  assert.equal(calls, 1); assert.equal(f.query, 'Fallback');
});

test('tasks: a missing title or status never renders "undefined"', () => {
  const [a] = taskProvider({ tasks: { active: () => ({ id: 't1', status: 'paused' }) }, now }).fetch({});
  assert.ok(!/undefined/.test(a.text)); assert.equal('query' in a, false);
  const [b] = taskProvider({ tasks: { active: () => ({ id: 't2', title: 'Report' }) }, now }).fetch({});
  assert.ok(!/undefined/.test(b.text)); assert.match(b.text, /Report/);
  const [c] = taskProvider({ tasks: { active: () => ({ id: 't3' }) }, now }).fetch({});
  assert.ok(!/undefined/.test(c.text));
});
