const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const cortexLib = require('../src/core/cortex');
const { createBus } = require('../src/core/bus');
const { createActivity } = require('../src/core/cortex/activity');
const { startBridge, okLabelOrigin } = require('../src/core/bridge');

const T0 = 1_700_000_000_000;
function setup() {
  const bus = createBus();
  const events = [];
  bus.on('brain', e => events.push(e));
  let t = T0;
  const c = cortexLib.open({ file: ':memory:', bus, now: () => t });
  const src = c.source.add({ kind: 'user', ref: 's' });
  const add = (kind, text, extra = {}) => c.node.upsert({ kind, text, source: src, ...extra }).id;
  return { c, bus, events, add, tick: ms => { t += ms; }, close: () => c.close() };
}

test('view: shape only (no text), most important nodes first, links among them with effective weights', () => {
  const { c, add, close } = setup();
  const rex = add('entity', 'Rex the dog, private words', { importance: 0.9 });
  const vet = add('fact', 'Rex has a vet visit in March', { importance: 0.4 });
  const low = add('fact', 'something minor', { importance: 0.1 });
  c.link(rex, vet, 'mentions');
  const v = c.view({ max: 40 });
  assert.equal(v.nodes[0].id, rex);
  assert.ok(v.nodes.every(n => !('text' in n)));
  assert.ok(v.nodes.every(n => Number.isFinite(n.c)), 'each node carries when it was created, so its place can mean its age');
  assert.ok(!JSON.stringify(v).includes('private words'));
  assert.equal(v.edges.length, 1);
  assert.deepEqual(v.edges[0].slice(0, 2), [rex, vet]);
  assert.ok(v.edges[0][2] > 0 && v.edges[0][2] <= 1);
  assert.equal(v.types[v.edges[0][3]], 'mentions');
  assert.equal(v.total.nodes, 3);
  // a focus node is included even when it falls outside the cap
  assert.ok(c.view({ max: 40, focus: [low] }).nodes.some(n => n.id === low));
  close();
});

test('view: archived nodes are left out, and an old unused link fades out of the picture', () => {
  const { c, add, tick, close } = setup();
  const a = add('fact', 'alpha'), b = add('fact', 'bravo'), gone = add('fact', 'charlie');
  c.link(a, b, 'touched'); c.link(a, gone, 'touched');
  c.node.archive(gone);
  let v = c.view();
  assert.ok(!v.nodes.some(n => n.id === gone));
  assert.equal(v.edges.length, 1);
  tick(400 * 864e5);   // 'touched' has a 30-day half-life: after 400 days the link is far below the visible floor
  v = c.view();
  assert.equal(v.edges.length, 0);
  close();
});

test('labels: a few words per node, first line only, capped, active nodes only', () => {
  const { c, add, close } = setup();
  const short = add('fact', 'Rex has a vet visit');
  const long = add('fact', 'A very long sentence about many different things that goes on and on\nsecond line');
  const gone = add('fact', 'archived one'); c.node.archive(gone);
  const l = c.labels([short, long, gone, 'x', 99999]);
  assert.equal(l[short], 'Rex has a vet visit');
  assert.ok(l[long].length <= 28 && l[long].endsWith('…') && !l[long].includes('second'));
  assert.ok(!(gone in l));
  assert.deepEqual(c.labels([]), {});
  close();
});

test('firing: recall sends the seeds and the links it followed; reinforce and writes send their ids; no text anywhere', async () => {
  const { c, add, events, tick, close } = setup();
  const rex = add('entity', 'Rex the dog'), vet = add('fact', 'Rex has a vet visit in March'), cal = add('fact', 'March calendar entry');
  c.link(rex, vet, 'mentions'); c.link(vet, cal, 'about');
  tick(1000);
  events.length = 0;
  await c.recall('vet visit');
  const rc = events.find(e => e.op === 'recall');
  assert.ok(rc, 'a recall event');
  assert.ok(rc.items.includes(vet));
  assert.ok(rc.seeds.includes(vet));
  assert.ok(rc.trail.some(([from, to]) => from === vet && (to === rex || to === cal)), 'the followed link is in the trail');
  assert.ok(!JSON.stringify(events).includes('vet visit'));
  tick(1000);
  c.reinforce([rex, vet]);
  assert.ok(events.some(e => e.op === 'use' && e.ids.includes(rex) && e.links === 1));
  close();
});

test('activity: writes are batched into one event, capped, and everything is rate-limited', () => {
  const sent = [];
  let t = 1000, timer = null;
  const a = createActivity({ bus: { emit: (type, p) => sent.push({ type, ...p }) }, now: () => t, setTimer: fn => { timer = fn; return {}; }, clearTimer: () => {} });
  for (let i = 1; i <= 500; i++) a.write(i);   // an import of 500 nodes
  assert.equal(sent.length, 0);
  timer();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 'write'); assert.equal(sent[0].ids.length, 48); assert.equal(sent[0].count, 500);
  a.use([1, 2]); a.use([3, 4]);   // same instant: the second is dropped
  assert.equal(sent.filter(e => e.op === 'use').length, 1);
  t += 500; a.use([5, 6]);
  assert.equal(sent.filter(e => e.op === 'use').length, 2);
  a.recall({ seeds: [], items: [], trail: [] });   // nothing to show: nothing sent
  assert.equal(sent.filter(e => e.op === 'recall').length, 0);
  assert.doesNotThrow(() => createActivity({ bus: { emit() { throw new Error('boom'); } } }).use([1]));
});

function freePort() { return new Promise(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function get(port, path, headers = {}) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path, headers }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
  });
}

test('bridge: /ai/brain serves the shape; /ai/brain/labels only when allowed and only to a page with no Origin or file://', async () => {
  const { c, add, close } = setup();
  const a = add('entity', 'Rex the dog'); const b = add('fact', 'vet visit'); c.link(a, b, 'mentions');
  let labelsOn = true;
  const port = await freePort();
  const bridge = await startBridge({ bus: createBus(), version: 't', ports: [port], brain: { view: o => c.view(o), labels: ids => c.labels(ids), labelsOn: () => labelsOn, skills: () => [{ id: 'media', label: 'Media', tools: ['media_control'] }] } });
  try {
    const shape = await get(port, `/ai/brain?max=40&focus=${a}`);
    assert.equal(shape.status, 200);
    const j = JSON.parse(shape.body);
    assert.equal(j.nodes.length, 2); assert.equal(j.labels, true);
    assert.deepEqual(j.skills, [{ id: 'media', label: 'Media', tools: ['media_control'] }]);
    assert.ok(!shape.body.includes('Rex the dog'));

    const ok = await get(port, `/ai/brain/labels?ids=${a},${b}`);                       // no Origin: the wallpaper
    assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body)[a], 'Rex the dog');
    assert.equal((await get(port, `/ai/brain/labels?ids=${a}`, { Origin: 'file://' })).status, 200);
    assert.equal((await get(port, `/ai/brain/labels?ids=${a}`, { Origin: 'null' })).status, 403);              // sandboxed frame on any site
    assert.equal((await get(port, `/ai/brain/labels?ids=${a}`, { Origin: 'http://localhost:3000' })).status, 403); // a local dev server
    assert.equal((await get(port, `/ai/brain/labels?ids=${a}`, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await get(port, `/ai/brain?max=40`, { Origin: 'http://localhost:3000' })).status, 200);      // the shape has no words, so it stays open like the stream
    labelsOn = false;
    assert.equal((await get(port, `/ai/brain/labels?ids=${a}`)).status, 403);                                   // the user switched labels off
    assert.equal(JSON.parse((await get(port, '/ai/brain')).body).labels, false);
  } finally { await bridge.close(); close(); }
  assert.equal(okLabelOrigin(undefined), true); assert.equal(okLabelOrigin('null'), false);
});

test('bridge: without a brain nothing is served, and brain events reach the stream as ids', async () => {
  const bus = createBus();
  const port = await freePort();
  const bridge = await startBridge({ bus, version: 't', ports: [port] });
  try {
    assert.equal((await get(port, '/ai/brain')).status, 404);
    const seen = await new Promise((res, rej) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/ai/stream' }, resp => {
        let buf = '';
        resp.on('data', d => { buf += d; if (buf.includes('event: state')) bus.emit('brain', { op: 'use', ids: [1, 2], links: 1 }); if (buf.includes('event: brain') && buf.includes('\n\n', buf.indexOf('event: brain'))) { r.destroy(); res(buf); } });
      });
      r.on('error', e => (e.code === 'ECONNRESET' ? null : rej(e)));
    });
    const data = JSON.parse(/event: brain\ndata: (.+)/.exec(seen)[1]);
    assert.equal(data.op, 'use'); assert.deepEqual(data.ids, [1, 2]);
  } finally { await bridge.close(); }
});
