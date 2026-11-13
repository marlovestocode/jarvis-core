// Intent interpretation wired into the turn (ADR A-002, Task 4): the orchestrator asks discover.resolveSelection which skill
// groups a turn needs. The model only recommends: confirm, taint and the guest allowlist still decide what runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { createConfirm } = require('../src/core/pc/confirm');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

const say = text => [{ type: 'token', text }, { type: 'done' }];
const call = (name, args) => [{ type: 'tool_call', id: 'c1', name, args }, { type: 'done' }];
const P = { type: 'object', properties: { action: { type: 'string' }, path: { type: 'string' } } };

function setup(script, constrain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-intent-'));
  const confirm = createConfirm({});
  const c = { deleted: 0, constrain };
  const groups = [
    { id: 'core', label: 'Core', triggers: [], tools: [{ name: 'get_time', description: 'time', params: P, sideEffects: 'read', async run() { return 'NOON'; } }] },
    { id: 'media', label: 'Media', triggers: [{ words: ['play', 'music', 'jazz', 'volume'], w: 3 }], tools: [{ name: 'media_control', description: 'media', params: P, sideEffects: 'write', async run() { return 'done'; } }] },
    { id: 'timers', label: 'Timers', triggers: [{ words: ['timer'], w: 3 }], tools: [{ name: 'set_timer', description: 'timer', params: P, sideEffects: 'write', async run() { return 'Timer set.'; } }] },
    { id: 'files', label: 'Files', triggers: [{ words: ['file', 'files'], w: 3 }], tools: [{ name: 'delete_file', description: 'delete', params: P, risk: 'confirm', async run(a) { return confirm.propose({ tool: 'delete_file', summary: `Delete ${a.path}`, args: a, run: async () => { c.deleted++; return 'Deleted.'; } }); } }] },
    { id: 'browser', label: 'Browser', triggers: [{ words: ['tabs'], w: 3 }], status: () => ({ ok: false, detail: 'extension not connected' }), tools: [{ name: 'list_tabs', description: 'tabs', params: P, sideEffects: 'read', async run() { return 'tabs'; } }] },
    { id: 'knowledge', label: 'Knowledge', triggers: [], tools: [{ name: 'lookup', description: 'facts', params: P, sideEffects: 'read', async run() { return 'fact'; } }] },
  ];
  const catalog = buildCatalog(groups);
  c.fp = createFakeProvider(script, { constrain: async req => c.constrain(req) });
  c.bus = createBus();
  c.events = [];
  c.bus.on('*', ev => c.events.push(ev));
  const providers = createRegistry(); providers.add(NullProvider); providers.add(c.fp);
  c.sessions = createSessionStore(dir);
  c.orc = createOrchestrator({
    bus: c.bus, sessions: c.sessions, providers, tools: createToolRunner(groups.flatMap(g => g.tools), { groups }), catalog,
    getConfig: () => ({ ...DEFAULTS, provider: c.fp.id }),
    selectGroups: (t, o) => selectGroups(t, o, catalog),
    route: () => ({ tier: 'deep', think: false, tools: true, reason: 'test' }),
  });
  c.s = c.sessions.create(); c.sessions.save(c.s);
  c.offered = n => (c.fp.calls[n].tools || []).map(t => t.name);
  c.routes = () => c.events.filter(e => e.type === 'route');
  c.done = () => fs.rmSync(dir, { recursive: true, force: true });
  return c;
}

test('follow-up: "do that again but quieter" after a media turn reuses media, with the history and decision on the route event', async () => {
  const c = setup([say('OK.'), say('OK.')], async () => ({ kind: 'followup', groups: [], confidence: 0.9, reasoning: 'repeats the last media action' }));
  await c.orc.send(c.s.id, 'play some jazz');
  assert.equal(c.fp.constrained.length, 0, 'a plain high-confidence command never waits on the model');
  assert.ok(c.offered(0).includes('media_control'));
  await c.orc.send(c.s.id, 'do that again but quieter');
  assert.equal(c.fp.constrained.length, 1);
  const data = c.fp.constrained[0].messages[1].content;
  assert.match(data, /last areas: media/);
  assert.match(data, /user: play some jazz/);
  assert.ok(c.offered(1).includes('media_control'), 'the follow-up gets the media tools back');
  const d = c.routes().at(-1).decision;
  assert.equal(d.kind, 'followup');
  assert.equal(d.status, 'ok');
  assert.equal(d.confidence, 0.9);
  assert.equal(d.reasoning, 'repeats the last media action');
  assert.ok(Number.isFinite(d.ms));
  assert.deepEqual(d.finalGroups, ['core', 'media']);
  assert.equal(c.routes()[0].decision, undefined, 'a gated turn keeps the plain route event');
  c.done();
});

test('correction: "no, the other one" moves to the group the model names', async () => {
  const c = setup([say('OK.'), say('OK.')], async () => ({ kind: 'correction', groups: ['timers'], confidence: 0.9 }));
  await c.orc.send(c.s.id, 'play some jazz');
  await c.orc.send(c.s.id, 'no, the other one');
  assert.ok(c.offered(1).includes('set_timer'));
  assert.ok(!c.offered(1).includes('media_control'));
  assert.equal(c.routes().at(-1).decision.kind, 'correction');
  c.done();
});

test('an ambiguous destructive request asks the model\'s question instead of acting', async () => {
  const c = setup([call('delete_file', { path: 'x' }), say('OK.')], async () => ({ kind: 'new', groups: ['files'], confidence: 0.3, ask: 'Which file do you want me to remove?' }));
  const res = await c.orc.send(c.s.id, 'clean up that stuff');
  assert.equal(res.reply, 'Which file do you want me to remove?');
  assert.equal(c.fp.calls.length, 0, 'no chat call, so no tool can run');
  assert.equal(c.routes().at(-1).decision.action, 'ask');
  c.done();
});

test('an unavailable capability is declined honestly from its card, not the model text', async () => {
  const c = setup([say('SHOULD NOT RUN')], async () => ({ kind: 'new', groups: ['browser'], confidence: 0.95, decline: 'sure thing!' }));
  const res = await c.orc.send(c.s.id, 'show what I have open in chrome');
  assert.match(res.reply, /unavailable \(extension not connected\)/);
  assert.equal(c.fp.calls.length, 0);
  c.done();
});

test('a guest or unsure speaker never reaches the interpreter and gains no tools', async () => {
  for (const speaker of ['guest', 'unsure']) {
    const c = setup([say('OK.')], async () => ({ kind: 'new', groups: ['files'], confidence: 0.99 }));
    await c.orc.send(c.s.id, 'bin the old report', { speaker });
    assert.equal(c.fp.constrained.length, 0, speaker);
    assert.ok(!c.offered(0).includes('delete_file'), speaker);
    c.done();
  }
});

test('a confirm tool still needs the OK even when the model recommends its group', async () => {
  const c = setup([call('delete_file', { path: 'report.txt' }), say('OK.')], async () => ({ kind: 'new', groups: ['files'], confidence: 0.95 }));
  const res = await c.orc.send(c.s.id, 'bin the old report');
  assert.equal(c.fp.constrained.length, 1);
  assert.ok(c.offered(0).includes('delete_file'));
  assert.match(res.reply, /Delete report\.txt\. Say yes to confirm\./);
  assert.equal(c.deleted, 0);
  c.done();
});

test('malformed or failing model output falls back to the rule path', async () => {
  for (const bad of [async () => 'garbage', async () => ({ foo: 1 }), async () => { throw new Error('boom'); }]) {
    const c = setup([say('OK.')], bad);
    const res = await c.orc.send(c.s.id, 'bin the old report');
    assert.equal(res.reply, 'OK.');
    assert.deepEqual(c.offered(0).sort(), ['get_time', 'lookup']);
    const d = c.routes().at(-1).decision;
    assert.equal(d.source, 'rule');
    assert.notEqual(d.status, 'ok');
    c.done();
  }
});
