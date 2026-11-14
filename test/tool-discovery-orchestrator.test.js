// Tool discovery wired into the turn: the tools that fit are offered (narrowed in specs() only), simple commands stay
// model-free and embed-free, a guest is refused without a model call, a no-match request is told not to invent a tool.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { createToolIndex } = require('../src/core/skills/toolindex');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner, eligibility } = require('../src/core/tools/registry');
const { createConfirm } = require('../src/core/pc/confirm');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');
const { createFakeProvider } = require('./helpers/fake-provider');

const say = text => [{ type: 'token', text }, { type: 'done' }];
const P = { type: 'object', properties: { action: { type: 'string' }, path: { type: 'string' } } };

function setup(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-tdisc-'));
  const confirm = createConfirm({});
  const groups = [
    { id: 'core', label: 'Core', triggers: [], tools: [{ name: 'get_time', description: 'time', params: P, sideEffects: 'read', async run() { return 'NOON'; } }] },
    { id: 'media', label: 'Media', triggers: [{ words: ['play', 'pause', 'music', 'jazz', 'volume'], w: 3 }], tools: [
      { name: 'media_control', description: 'Pause, play or skip the music.', params: P, sideEffects: 'write', async run() { return 'done'; } },
      { name: 'media_volume', description: 'Set the music volume.', params: P, sideEffects: 'write', async run() { return 'done'; } },
    ] },
    { id: 'files', label: 'Files', triggers: [{ words: ['file', 'files'], w: 3 }], tools: [{ name: 'delete_file', description: 'Delete a file.', params: P, risk: 'confirm', async run(a) { return confirm.propose({ tool: 'delete_file', summary: `Delete ${a.path}`, args: a, run: async () => 'Deleted.' }); } }] },
  ];
  const catalog = buildCatalog(groups);
  const c = { embeds: 0 };
  const fake = createFakeEmbedder({});
  const embed = (t, o) => { c.embeds++; return fake.embed(t, o); };
  c.fp = createFakeProvider(script, { constrain: async () => ({ kind: 'new', groups: [], confidence: 0.9 }) });
  c.bus = createBus();
  const providers = createRegistry(); providers.add(NullProvider); providers.add(c.fp);
  c.sessions = createSessionStore(dir);
  const toolIndex = createToolIndex({ catalog, embed, eligible: eligibility });
  c.orc = createOrchestrator({
    bus: c.bus, sessions: c.sessions, providers, tools: createToolRunner(groups.flatMap(g => g.tools), { groups, toolIndex }), catalog, toolIndex,
    getConfig: () => ({ ...DEFAULTS, provider: c.fp.id }),
    selectGroups: (t, o) => selectGroups(t, o, catalog),
    route: () => ({ tier: 'deep', think: false, tools: true, reason: 'test' }),
  });
  c.s = c.sessions.create(); c.sessions.save(c.s);
  c.offered = n => (c.fp.calls[n].tools || []).map(t => t.name);
  c.done = () => fs.rmSync(dir, { recursive: true, force: true });
  return c;
}

test('a simple command offers few tools with no model call and no embed call', async () => {
  const c = setup([say('OK.')]);
  await c.orc.send(c.s.id, 'pause the music');
  assert.equal(c.fp.constrained.length, 0);
  assert.equal(c.embeds, 0);
  assert.ok(c.offered(0).includes('media_control'));
  assert.ok(c.offered(0).length <= 8 + 2);
  c.done();
});

test('a guest asking for a tool it may not use is refused without a model call', async () => {
  const c = setup([say('OK.')]);
  const r = await c.orc.send(c.s.id, 'delete my file', { speaker: 'guest' });
  assert.equal(r.reply, 'I only do that for my owner.');
  assert.equal(c.fp.calls.length, 0);
  c.done();
});

test('a request no tool matches tells the model not to invent one', async () => {
  const c = setup([say('I cannot do that.')]);
  await c.orc.send(c.s.id, 'xyzzy plugh frobnicate');
  assert.equal(c.fp.calls.length >= 1, true);
  const msgs = c.fp.calls[0].messages;
  assert.match(msgs[msgs.length - 1].content, /do not invent one/);
  c.done();
});
