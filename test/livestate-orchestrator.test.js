// Live-state follow-up wiring in the orchestrator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

function setup({ live, selectGroups, route } = {}) {
  const fp = createFakeProvider([{ type: 'token', text: 'Okay.' }, { type: 'done' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-live-'));
  const bus = createBus();
  const events = [];
  bus.on('*', ev => events.push(ev));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(fp);
  const orc = createOrchestrator({
    bus, sessions, providers, tools: createToolRunner([]), getConfig: () => ({ ...DEFAULTS, provider: fp.id }),
    live, selectGroups, route,
  });
  const s = sessions.create(); sessions.save(s);
  return { fp, events, orc, s };
}
const chatRoute = () => ({ tier: 'fast', think: false, tools: false, reason: 'chat' });
const now = Date.now();
const contSnap = () => ({ t: now, tools: [{ t: now }], groups: { list: ['media'] }, media: null, confirm: null });

test('livestate: without live a turn behaves as before', async () => {
  const seen = [];
  const { fp, events, orc, s } = setup({ selectGroups: (t, o) => { seen.push(o.lastGroups); return ['core']; }, route: chatRoute });
  const res = await orc.send(s.id, 'do it again', { source: 'text' });
  assert.equal(res.reply, 'Okay.');
  assert.deepEqual(seen, [[]]);
  assert.equal(fp.calls[0].tools === undefined || fp.calls[0].tools.length === 0, true);
  assert.ok(!events.some(e => e.type === 'followup'));
});

test('livestate: a continue follow-up feeds groups to selectGroups and upgrades to tools', async () => {
  const seen = [];
  const { fp, events, orc, s } = setup({
    live: { snapshot: contSnap },
    selectGroups: (t, o) => { seen.push(o.lastGroups); return ['core']; },
    route: chatRoute,
  });
  await orc.send(s.id, 'do it again', { source: 'text' });
  assert.ok(events.some(e => e.type === 'followup' && e.kind === 'continue'));
  assert.deepEqual(seen, [['media']]);
  assert.equal(fp.calls[0].hints.tools, true);
  assert.equal(fp.calls[0].hints.reason, 'follow-up');
  assert.equal(fp.calls[0].hints.tier, 'deep');
});

test('livestate: a throwing snapshot is swallowed with a warn log', async () => {
  const base = setup({ route: chatRoute });
  const r0 = await base.orc.send(base.s.id, 'do it again', { source: 'text' });
  const { fp, events, orc, s } = setup({ live: { snapshot() { throw new Error('boom'); } }, route: chatRoute });
  const res = await orc.send(s.id, 'do it again', { source: 'text' });
  assert.equal(res.reply, r0.reply);
  assert.ok(events.some(e => e.type === 'log' && e.level === 'warn' && /boom/.test(e.text)));
  assert.ok(!events.some(e => e.type === 'followup'));
  assert.equal(fp.calls[0].hints.tools, false);
});

test('livestate: a media follow-up only emits the event', async () => {
  const snap = { t: now, tools: [], groups: { list: [] }, media: { playing: true }, confirm: null };
  const { fp, events, orc, s } = setup({ live: { snapshot: () => snap }, route: chatRoute });
  await orc.send(s.id, 'pause', { source: 'text' });
  assert.ok(events.some(e => e.type === 'followup' && e.kind === 'media'));
  assert.equal(fp.calls[0].hints.tools, false);
  assert.equal(fp.calls[0].hints.reason, 'chat');
});

test('livestate: getLastGroups returns [] with no history', () => {
  const { orc } = setup();
  assert.deepEqual(orc.getLastGroups(), []);
  assert.deepEqual(orc.getLastGroups('nope'), []);
});
