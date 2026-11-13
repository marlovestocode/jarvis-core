const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../extension/util.js');

test('ext util: backoff doubles to a cap and jitters inside its band', async () => {
  const { backoff } = await load();
  assert.equal(backoff(0, { random: () => 1 }), 2000);
  assert.equal(backoff(1, { random: () => 1 }), 4000);
  assert.equal(backoff(9, { random: () => 1 }), 30000);
  for (let i = 0; i < 100; i++) { const v = backoff(2); assert.ok(v >= 4000 && v <= 8000, String(v)); }
});

test('ext util: the queue runs jobs one at a time, so two read-modify-writes cannot lose an item', async () => {
  const { createQueue } = await load();
  const q = createQueue();
  let store = [];
  const add = x => q(async () => { const cur = [...store]; await new Promise(r => setTimeout(r, 5)); cur.push(x); store = cur; });
  await Promise.all([add(1), add(2), add(3), add(4)]);
  assert.deepEqual(store, [1, 2, 3, 4]);
  // the same code without the queue loses items: this is the bug being fixed
  store = [];
  const raw = async x => { const cur = [...store]; await new Promise(r => setTimeout(r, 5)); cur.push(x); store = cur; };
  await Promise.all([raw(1), raw(2), raw(3), raw(4)]);
  assert.equal(store.length, 1);
  // a failing job does not stop the next one
  await assert.rejects(q(async () => { throw new Error('x'); }), /x/);
  assert.equal(await q(async () => 'next'), 'next');
});

test('ext util: describeArgs is short and carries no page text, query strings or keys', async () => {
  const { describeArgs } = await load();
  assert.equal(describeArgs({ query: 'blinding lights' }), 'blinding lights');
  assert.equal(describeArgs({ url: 'https://example.com/p?token=secret' }), 'https://example.com/p');
  assert.equal(describeArgs({}), '');
  assert.ok(describeArgs({ query: 'x'.repeat(500) }).length <= 60);
});

test('ext util: pushRing keeps the newest', async () => {
  const { pushRing } = await load();
  let l = [];
  for (let i = 0; i < 150; i++) l = pushRing(l, i, 100);
  assert.equal(l.length, 100); assert.equal(l[0], 50); assert.equal(l.at(-1), 149);
});
