// Speaker lockout (speaker recognition, Task 4): a guest or unsure voice never acts as the owner.
// unsure: tainted for tools and writes, keeps the owner's prompt context. guest: tainted and the prompt drops the owner's personal context.
// Both: no memory recall or memo, no pre-model shortcut that acts or writes, no resolving a pending confirm.
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
const { createConfirm } = require('../src/core/pc/confirm');
const { createMemorySkill } = require('../src/core/memory/skill');
const { instant } = require('../src/core/brain/instant');
const { systemPrompt } = require('../src/core/brain/prompt');
const { createGroup } = require('../src/core/skills/core');
const { createTaskStore } = require('../src/core/tasks/store');
const { createTaskRunner } = require('../src/core/tasks/runner');
const { createTaskTools } = require('../src/core/tools/tasks');
const { createFakeProvider } = require('./helpers/fake-provider');

const call = (id, name, args = {}) => [{ type: 'tool_call', id, name, args }, { type: 'done' }];
const say = text => [{ type: 'token', text }, { type: 'done' }];

const GUEST_TEXT = 'Error: I only do that for my owner.';
const UNSURE_TEXT = "Error: I can't be sure it's you, so I won't do that by voice. Confirm with the keyboard or the hotkey.";
const PAGE_TEXT = "Error: I won't start that from text I read. Ask me directly.";

// The owner's personal context, as promptInfo gives it in src/main/main.js
const INFO = {
  user: { name: 'Daniel', about: 'I build robots in Leeds', city: 'Leeds', teams: ['Leeds United'], playlists: 7, voiceEnrolled: true },
  memory: 'likes jazz piano',
  memoryIds: ['p1'],
  library: 'Library: SECRETPLAYLIST',
  media: 'Media: Spotify is playing OWNERSONG',
  live: 'Live: timer OWNERTIMER 5 min left',
  hardware: { cpu: 'Ryzen', gpu: 'RTX' },
};
const PERSONAL = ['Daniel', 'I build robots', 'Leeds', 'likes jazz piano', 'SECRETPLAYLIST', 'OWNERSONG', 'OWNERTIMER', 'MEMOFACT'];

function setup(script, { route } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-speaker-'));
  const c = { ran: [], turns: [], adds: [], names: [], mem: [] };
  const bus = createBus();
  c.sessions = createSessionStore(dir);
  c.confirm = createConfirm({});
  const memory = { add: f => { c.adds.push(f); return { ok: true, text: f }; }, forget: () => ({ removed: [] }) };
  c.memorySkill = createMemorySkill({ memory, setName: n => c.names.push(n) });
  c.toolList = [
    { name: 'get_time', description: 'time', params: {}, async run(a, ctx) { c.turns.push(ctx.turn); c.ran.push('get_time'); return 'NOON'; } },
    { name: 'close_app', description: 'Close an app after a yes.', params: {}, risk: 'confirm',
      async run() { c.ran.push('close_app:propose'); return c.confirm.propose({ tool: 'close_app', summary: 'Close Notepad', args: {}, run: async () => { c.ran.push('close_app:run'); return 'Closed Notepad.'; } }); } },
    { name: 'remember', description: 'Save a fact.', params: { type: 'object', properties: { fact: { type: 'string' } } }, needsClean: true,
      async run({ fact }) { c.ran.push(`remember:${fact}`); memory.add(fact); return 'Saved.'; } },
    { name: 'read_page', description: 'Read a page.', params: {}, untrusted: true, async run() { c.ran.push('read_page'); return 'Page text.'; } },
  ];
  c.tools = createToolRunner(c.toolList);
  c.fp = createFakeProvider(script);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(c.fp);
  c.block = {
    onUserMessage: a => c.mem.push(['onUserMessage', a]),
    forTurn: async a => { c.mem.push(['forTurn', a]); return { memo: 'Recalled: MEMOFACT', ids: ['r1'] }; },
    afterTurn: a => c.mem.push(['afterTurn', a]),
  };
  c.orc = createOrchestrator({
    bus, sessions: c.sessions, providers, tools: c.tools,
    getConfig: () => ({ ...DEFAULTS, provider: c.fp.id }),
    systemPrompt, promptInfo: () => ({ ...INFO }), route,
    fastPath: async (text, o) => (await c.confirm.handle(text, o)) || (await c.memorySkill.handle(text, o)) || instant(text, { now: new Date() }),
    memoryBlock: c.block,
    onQuestionLost: () => c.confirm.clear(),
  });
  c.s = c.sessions.create();
  c.sessions.save(c.s);
  c.toolMsg = () => c.sessions.load(c.s.id).messages.filter(m => m.role === 'tool').at(-1)?.content;
  c.sys = n => c.fp.calls[n].messages[0].content;
  c.sent = n => c.fp.calls[n].messages.map(m => String(m.content)).join('\n');
  return c;
}

test('guest: a confirm tool is refused with the guest text and never proposes', async () => {
  const c = setup([call('c1', 'close_app'), say('I cannot.')]);
  await c.orc.send(c.s.id, 'close notepad', { source: 'voice', speaker: 'guest' });
  assert.equal(c.toolMsg(), GUEST_TEXT);
  assert.deepEqual(c.ran, []);
  assert.equal(c.confirm.pending(), null);
});

test('unsure: a confirm tool is refused with the unsure text', async () => {
  const c = setup([call('c1', 'close_app'), say('I cannot.')]);
  await c.orc.send(c.s.id, 'close notepad', { source: 'voice', speaker: 'unsure' });
  assert.equal(c.toolMsg(), UNSURE_TEXT);
  assert.deepEqual(c.ran, []);
});

test('guest and unsure: the memory write tool is refused, nothing saved', async () => {
  for (const [speaker, text] of [['guest', GUEST_TEXT], ['unsure', UNSURE_TEXT]]) {
    const c = setup([call('c1', 'remember', { fact: 'owner is away' }), say('No.')]);
    await c.orc.send(c.s.id, 'note that the owner is away', { source: 'voice', speaker });
    assert.equal(c.toolMsg(), text, speaker);
    assert.deepEqual(c.ran, [], speaker);
    assert.deepEqual(c.adds, [], speaker);
  }
});

test('the page taint text is unchanged for an owner turn that read outside text', async () => {
  const c = setup([call('c1', 'read_page'), call('c2', 'close_app'), say('done')]);
  await c.orc.send(c.s.id, 'read the page and close notepad', { source: 'text' });
  assert.equal(c.toolMsg(), PAGE_TEXT);
});

test('guest prompt: none of the owner\'s personal context, plus the guest line; earlier memos are not sent', async () => {
  const c = setup([say('Hi owner.'), say('Hello there.')]);
  await c.orc.send(c.s.id, 'hello', { source: 'voice' });   // owner turn: saves a memo on its message
  assert.ok(c.sent(0).includes('MEMOFACT'), 'owner turn gets the recalled memo');
  await c.orc.send(c.s.id, 'who lives here?', { source: 'voice', speaker: 'guest' });
  const sys = c.sys(1);
  const all = c.sent(1);
  for (const p of PERSONAL) assert.ok(!all.includes(p), `guest window leaks ${p}`);
  assert.match(sys, /not the owner/i);
  assert.match(sys, /personal information/i);
  assert.match(sys, /general questions/i);
  assert.ok(sys.includes('Ryzen'), 'non-personal facts stay');
});

test('guest brief prompt (quick chat) also drops the owner context and has the guest line', async () => {
  const c = setup([say('Hello.')], { route: () => ({ tier: 'quick', tools: false, think: false }) });
  await c.orc.send(c.s.id, 'hi there', { source: 'voice', speaker: 'guest' });
  const all = c.sent(0);
  for (const p of PERSONAL) assert.ok(!all.includes(p), `guest brief leaks ${p}`);
  assert.match(c.sys(0), /not the owner/i);
});

test('unsure prompt keeps the owner\'s context and has no guest line', async () => {
  const c = setup([say('Hi.')]);
  await c.orc.send(c.s.id, 'hello', { source: 'voice', speaker: 'unsure' });
  const sys = c.sys(0);
  assert.ok(sys.includes('Daniel'));
  assert.ok(sys.includes('I build robots'));
  assert.ok(sys.includes('likes jazz piano'));
  assert.doesNotMatch(sys, /not the owner/i);
});

test('non-owner turns never touch the memory block', async () => {
  for (const speaker of ['guest', 'unsure']) {
    const c = setup([say('ok')]);
    await c.orc.send(c.s.id, 'what do you know', { source: 'voice', speaker });
    assert.deepEqual(c.mem, [], speaker);
    assert.equal(c.sessions.load(c.s.id).messages[0].memo, undefined, speaker);
  }
});

test('guest "call me Bob" and "remember that X" change nothing', async () => {
  for (const speaker of ['guest', 'unsure']) {
    const c = setup([say('Sure.')]);
    await c.orc.send(c.s.id, 'call me Bob', { source: 'voice', speaker });
    await c.orc.send(c.s.id, 'remember that the safe code is 1234', { source: 'voice', speaker });
    assert.deepEqual(c.names, [], speaker);
    assert.deepEqual(c.adds, [], speaker);
    assert.equal(c.fp.calls.length, 2, `${speaker}: both went to the model`);
  }
});

test('a pure-read instant answer still works for a guest', async () => {
  const c = setup([say('should not be asked')]);
  const r = await c.orc.send(c.s.id, 'what time is it', { source: 'voice', speaker: 'guest' });
  assert.match(r.reply, /^It's /);
  assert.equal(c.fp.calls.length, 0);
  const m = await c.orc.send(c.s.id, 'what is 12 times 3', { source: 'voice', speaker: 'guest' });
  assert.match(m.reply, /36/);
});

test('a guest or unsure "yes" never resolves the owner\'s pending confirm', async () => {
  const c = setup([call('c1', 'close_app'), say('Model reply.')]);
  const q = await c.orc.send(c.s.id, 'close notepad', { source: 'text' });
  assert.equal(q.reply, 'Close Notepad. Say yes to confirm.');
  for (const speaker of ['guest', 'unsure']) {
    await c.orc.send(c.s.id, 'yes', { source: 'voice', speaker });
    assert.ok(!c.ran.includes('close_app:run'), speaker);
    assert.ok(c.confirm.pending(), `${speaker}: the owner's question still stands`);
  }
  const y = await c.orc.send(c.s.id, 'yes', { source: 'text' });
  assert.equal(y.reply, 'Closed Notepad.');
  assert.ok(c.ran.includes('close_app:run'));
});

test('an unknown speaker value fails closed as a guest', async () => {
  const c = setup([call('c1', 'close_app'), say('No.')]);
  await c.orc.send(c.s.id, 'close notepad', { source: 'voice', speaker: 'stranger' });
  assert.equal(c.toolMsg(), GUEST_TEXT);
  assert.ok(!c.sys(0).includes('Daniel'));
});

test('owner turns are unchanged: context, memory, shortcuts and a clean turn', async () => {
  for (const opts of [{ source: 'voice' }, { source: 'voice', speaker: 'owner' }, { source: 'text' }]) {
    const c = setup([call('c1', 'get_time'), say('It is noon.')]);
    await c.orc.send(c.s.id, 'what is the time in my style', opts);
    assert.deepEqual(c.turns, [{ source: opts.source, tainted: false }]);
    assert.ok(c.sys(0).includes('Daniel') && c.sys(0).includes('likes jazz piano'));
    assert.doesNotMatch(c.sys(0), /not the owner/i);
    assert.deepEqual(c.mem.map(x => x[0]), ['onUserMessage', 'forTurn', 'afterTurn']);
    await c.orc.send(c.s.id, 'call me Bob', opts);
    assert.deepEqual(c.names, ['Bob']);
  }
});

// Tasks: a task started by a non-owner turn carries the taint through the runner
function taskSetup(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-speaker-task-'));
  const c = { ran: [] };
  const bus = createBus();
  c.sessions = createSessionStore(path.join(dir, 'sessions'));
  c.confirm = createConfirm({});
  c.store = createTaskStore({ dir: path.join(dir, 'tasks') });
  c.tasks = createTaskRunner({
    store: c.store, bus,
    tools: { run: (...a) => c.tools.run(...a), resolves: n => c.tools.resolves(n) },
    riskOf: n => c.toolList.find(t => t.name === n)?.risk,
    confirmPending: () => c.confirm.pending(),
    onCancel: () => c.confirm.clear(),
  });
  const core = createGroup({ tasks: createTaskTools({ runner: c.tasks }) });
  const pc = { id: 'pc', label: 'PC', triggers: [], tools: [
    { name: 'big_files', description: 'List big files.', params: { type: 'object', properties: {} }, risk: 'safe', async run() { c.ran.push('big_files'); return 'movie.mkv'; } },
    { name: 'delete_file', description: 'Delete a file after a yes.', params: { type: 'object', properties: { name: { type: 'string' } } }, risk: 'confirm',
      async run({ name }) { c.ran.push('delete_file:propose'); return c.confirm.propose({ tool: 'delete_file', summary: `Delete ${name}`, args: { name }, run: async () => { c.ran.push('delete_file:run'); return 'Deleted.'; } }); } },
    { name: 'remember', description: 'Save a fact.', params: { type: 'object', properties: { fact: { type: 'string' } } }, risk: 'safe', needsClean: true,
      async run({ fact }) { c.ran.push(`remember:${fact}`); return 'Noted.'; } },
  ] };
  c.toolList = [...core.tools, ...pc.tools];
  c.tools = createToolRunner(c.toolList, { groups: [core, pc] });
  c.fp = createFakeProvider(script);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(c.fp);
  c.orc = createOrchestrator({
    bus, sessions: c.sessions, providers, tools: c.tools,
    getConfig: () => ({ ...DEFAULTS, provider: c.fp.id }),
    fastPath: async (text, o) => c.confirm.handle(text, o),
  });
  c.s = c.sessions.create();
  c.sessions.save(c.s);
  return c;
}

test('guest task_run: a confirm step is refused and a memory step never writes', async () => {
  const a = taskSetup([call('c1', 'task_run', { title: 'Clean', steps: [{ tool: 'big_files' }, { tool: 'delete_file', args: { name: 'movie.mkv' } }] }), say('No.')]);
  await a.orc.send(a.s.id, 'delete my biggest file', { source: 'voice', speaker: 'guest' });
  assert.ok(!a.ran.includes('delete_file:propose'));
  assert.equal(a.confirm.pending(), null);

  const b = taskSetup([call('c1', 'task_run', { title: 'Note', steps: [{ tool: 'big_files' }, { tool: 'remember', args: { fact: 'x' } }] }), say('No.')]);
  await b.orc.send(b.s.id, 'find big files then remember x', { source: 'voice', speaker: 'unsure' });
  assert.ok(!b.ran.some(r => r.startsWith('remember')), 'the memory step did not run');
});

// ---- fix wave: guest tool allowlist, task taint persistence, history, pendingAsk, wording ----
const { toolDeps } = require('./helpers/tool-deps');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { createMemoryTools } = require('../src/core/tools/memory');
const { validatePlan } = require('../src/core/tasks/plan');

const GUEST = { source: 'voice', tainted: true, speaker: 'guest' };
const UNSURE = { source: 'voice', tainted: true, speaker: 'unsure' };
// the exact guest allowlist: a new tool is denied for guests until it is added on purpose
const ALLOWED = ['get_time', 'more_skills', 'get_weather', 'weather_alerts', 'weather_threat', 'news_headlines', 'sports_scores', 'lookup_knowledge', 'read_article',
  'calculate', 'solve_equation', 'integrate', 'differentiate', 'statistics', 'convert_units', 'physics_constant', 'date_calc', 'web_search', 'web_open', 'find_song_by_lyric'];
const NEEDS = { get_weather: { place: 'Paris' }, weather_alerts: { place: 'Dallas' }, weather_threat: { place: 'Dallas' }, sports_scores: { team: 'Cowboys' } };

// the real catalog, every tool's run replaced by a recorder
function realCatalog() {
  const d = toolDeps();
  d.tasks = createTaskTools({ runner: {} });
  const cat = buildCatalog(loadGroups(d));
  const called = [];
  const wrap = t => ({ ...t, run: async () => { called.push(t.name); return 'ok'; } });
  const groups = cat.groups.map(g => ({ ...g, tools: g.tools.map(wrap) }));
  const tools = groups.flatMap(g => g.tools);
  return { called, tools, runner: createToolRunner(tools, { groups }) };
}
// smallest arguments that fit a tool's schema
function argsFor(t) {
  if (NEEDS[t.name]) return NEEDS[t.name];
  const out = {};
  const props = t.params?.properties || {};
  for (const k of t.params?.required || []) {
    const p = props[k] || {};
    out[k] = p.enum ? p.enum[0] : p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'array' ? [] : p.type === 'object' ? {} : 'x';
  }
  return out;
}

test('guest allowlist over the real catalog: every other tool is refused with the guest text, allowed tools run', async () => {
  const { called, tools, runner } = realCatalog();
  const names = tools.map(t => t.name);
  for (const a of ALLOWED) assert.ok(names.includes(a), `allowlisted ${a} exists`);
  for (const t of tools) {
    called.length = 0;
    const r = await runner.run(t.name, argsFor(t), { turn: { ...GUEST } });
    if (ALLOWED.includes(t.name)) {
      assert.deepEqual(called, [t.name], `${t.name} should run for a guest (${r.text})`);
    } else {
      assert.equal(r.text, GUEST_TEXT, `${t.name} must be refused for a guest`);
      assert.deepEqual(called, [], `${t.name} must not run`);
    }
  }
});

test('guest allowlist: the scoped auto-load path refuses without loading the group', async () => {
  const { called, runner } = realCatalog();
  const scope = runner.turn(['core']);
  const r = await scope.run('memory_about', { topic: 'Rex' }, { turn: { ...GUEST } });
  assert.equal(r.text, GUEST_TEXT);
  assert.deepEqual(scope.loaded(), ['core']);
  assert.deepEqual(called, []);
});

test('guest: weather and scores need a named place or team (the owner\'s home and teams are private)', async () => {
  const { called, runner } = realCatalog();
  for (const n of ['get_weather', 'weather_alerts', 'weather_threat', 'sports_scores']) {
    const r = await runner.run(n, {}, { turn: { ...GUEST } });
    assert.match(r.text, /^Error: /, n);
    assert.deepEqual(called, [], n);
  }
});

test('unsure and owner turns are not held to the guest allowlist', async () => {
  const { called, runner } = realCatalog();
  await runner.run('memory_about', { topic: 'Rex' }, { turn: { ...UNSURE } });
  await runner.run('media_status', {}, { turn: { ...UNSURE } });
  await runner.run('memory_about', { topic: 'Rex' }, { turn: { source: 'text', tainted: false } });
  await runner.run('get_weather', {}, { turn: { source: 'text', tainted: false } });
  assert.deepEqual(called, ['memory_about', 'media_status', 'memory_about', 'get_weather']);
});

test('guest memory_about through the orchestrator: guest text and the cortex is never read', async () => {
  const reads = [];
  const cortex = new Proxy({}, { get: (t, k) => { reads.push(String(k)); return () => null; } });
  const tools = createToolRunner(createMemoryTools({ memory: { add: () => ({ ok: true }), forget: () => ({ removed: [] }) }, cortex }));
  const fp = createFakeProvider([call('c1', 'memory_about', { topic: 'Daniel' }), say('I cannot say.')]);
  const sessions = createSessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-speaker-mem-')));
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(fp);
  const orc = createOrchestrator({ bus: createBus(), sessions, providers, tools, getConfig: () => ({ ...DEFAULTS, provider: fp.id }) });
  const s = sessions.create();
  sessions.save(s);
  await orc.send(s.id, 'what do you know about Daniel', { source: 'voice', speaker: 'guest' });
  assert.equal(sessions.load(s.id).messages.find(m => m.role === 'tool').content, GUEST_TEXT);
  assert.deepEqual(reads, []);
});

// a task started by a tainted turn stays tainted when the owner resumes it
function runnerSetup() {
  const c = { ran: [], ac: new AbortController() };
  c.store = createTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jc-speaker-run-')) });
  c.toolList = [
    { name: 'big_files', description: 'b', params: {}, risk: 'safe', async run() { c.ran.push('big_files'); c.ac.abort(); return 'movie.mkv'; } },
    { name: 'folder_size', description: 'f', params: {}, risk: 'safe', async run() { c.ran.push('folder_size'); return 'big'; } },
    { name: 'remember', description: 'r', params: { type: 'object', properties: { fact: { type: 'string' } } }, risk: 'safe', needsClean: true, async run({ fact }) { c.ran.push(`remember:${fact}`); return 'Noted.'; } },
    { name: 'close_app', description: 'c', params: {}, risk: 'confirm', async run() { c.ran.push('close_app'); return 'x'; } },
  ];
  c.tools = createToolRunner(c.toolList);
  c.tasks = createTaskRunner({ store: c.store, tools: c.tools, riskOf: n => c.toolList.find(t => t.name === n)?.risk });
  return c;
}

test('task taint persists: started in an unsure turn, resumed by the owner, the needsClean step is still refused', async () => {
  const c = runnerSetup();
  const r = await c.tasks.start({ title: 'Note', steps: [{ tool: 'big_files' }, { tool: 'remember', args: { fact: 'x' } }], turn: { ...UNSURE }, signal: c.ac.signal });
  const id = r.task.id;
  assert.equal(c.store.get(id).tainted, true, 'saved tainted');
  assert.equal(c.store.get(id).status, 'paused');
  const res = await c.tasks.resume(id, { turn: { source: 'text', tainted: false } });
  assert.ok(!c.ran.some(x => x.startsWith('remember')), `the memory step did not run: ${res.text}`);
});

test('task taint persists on replan by a tainted turn', async () => {
  const c = runnerSetup();
  c.toolList[1].run = async () => { throw new Error('boom'); };
  const f = await c.tasks.start({ title: 'T', steps: [{ tool: 'folder_size' }], turn: { source: 'text', tainted: false } });
  assert.equal(f.task.status, 'failed');
  assert.notEqual(c.store.get(f.task.id).tainted, true);
  await c.tasks.replan(f.task.id, [{ tool: 'big_files' }], { turn: { ...UNSURE } });
  assert.equal(c.store.get(f.task.id).tainted, true);
});

test('refusal wording names the speaker: plan validation, task step and clipboard write', async () => {
  const v = validatePlan([{ tool: 'close_app' }], { resolves: () => true, riskOf: () => 'confirm', tainted: true, speaker: 'unsure' });
  assert.match(v.text, /can't be sure it's you/);
  const g = validatePlan([{ tool: 'close_app' }], { resolves: () => true, riskOf: () => 'confirm', tainted: true, speaker: 'guest' });
  assert.match(g.text, /only do that for my owner/);
  const p = validatePlan([{ tool: 'close_app' }], { resolves: () => true, riskOf: () => 'confirm', tainted: true });
  assert.match(p.text, /untrusted content/);

  const c = runnerSetup();
  const turn = { source: 'voice', tainted: false };
  // the shared turn becomes speaker-tainted between validation and the confirm step
  c.toolList[1].run = async () => { Object.assign(turn, { tainted: true, speaker: 'unsure' }); return 'big'; };
  const r = await c.tasks.start({ title: 'T', steps: [{ tool: 'folder_size' }, { tool: 'close_app' }], turn });
  assert.match(r.text, /can't be sure it's you/);
  assert.ok(!c.ran.includes('close_app'));

  const cat = buildCatalog(loadGroups(toolDeps()));
  const runner = createToolRunner(cat.tools, { groups: cat.groups });
  const w = await runner.run('clipboard_write', { text: 'hi' }, { turn: { ...UNSURE } });
  assert.equal(w.text, UNSURE_TEXT);
});

test('guest window: earlier chat is never sent; the saved session keeps it; the guest message is marked', async () => {
  const c = setup([say('Stored in the vault.'), say('Hello.')]);
  await c.orc.send(c.s.id, 'my locker code is SECRETCHAT', { source: 'text' });
  await c.orc.send(c.s.id, 'hello who are you', { source: 'voice', speaker: 'guest' });
  const sent = c.fp.calls[1].messages.map(m => String(m.content)).join('\n');
  assert.ok(!sent.includes('SECRETCHAT'));
  assert.ok(!sent.includes('Stored in the vault.'));
  assert.ok(sent.includes('hello who are you'));
  const msgs = c.sessions.load(c.s.id).messages;
  assert.equal(msgs[0].content, 'my locker code is SECRETCHAT');
  assert.equal(msgs[0].speaker, undefined);
  assert.equal(msgs.find(m => m.content === 'hello who are you').speaker, 'guest');
});

test('unsure window keeps the chat history; the unsure message is marked', async () => {
  const c = setup([say('Stored in the vault.'), say('Hello.')]);
  await c.orc.send(c.s.id, 'my locker code is SECRETCHAT', { source: 'text' });
  await c.orc.send(c.s.id, 'what was it', { source: 'voice', speaker: 'unsure' });
  assert.ok(c.fp.calls[1].messages.some(m => String(m.content).includes('SECRETCHAT')));
  assert.equal(c.sessions.load(c.s.id).messages.at(-2).speaker, 'unsure');
});

function askSetup({ resolveSelection } = {}) {
  const c = { fpTexts: [], picks: [] };
  c.sessions = createSessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-speaker-ask-')));
  const groups = [{ id: 'core', label: 'Core', triggers: [], tools: [{ name: 'get_time', description: 't', params: {}, async run() { return 'NOON'; } }] },
    { id: 'timers', label: 'Timers', triggers: [], tools: [{ name: 'set_timer', description: 's', params: {}, async run() { return 'Timer set.'; } }] }];
  c.tools = createToolRunner(groups.flatMap(g => g.tools), { groups });
  c.fp = createFakeProvider([say('ok')], { constrain: async () => ({}) });
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(c.fp);
  c.orc = createOrchestrator({
    bus: createBus(), sessions: c.sessions, providers, tools: c.tools, catalog: {},
    getConfig: () => ({ ...DEFAULTS, provider: c.fp.id }),
    selectGroups: (text, o) => { c.picks.push({ text, lastGroups: o.lastGroups }); return /timer|minutes/.test(text) ? Object.assign(['core', 'timers'], { confidence: resolveSelection ? 'low' : 'high' }) : ['core']; },
    fastPath: async text => { c.fpTexts.push(text); return text === 'set a timer' ? { reply: 'For how long?', ask: true } : null; },
    ...(resolveSelection ? { resolveSelection } : {}),
  });
  c.s = c.sessions.create();
  c.sessions.save(c.s);
  return c;
}

test('pendingAsk: a guest turn neither consumes the owner\'s question nor leaves its own for the owner', async () => {
  const c = askSetup();
  await c.orc.send(c.s.id, 'set a timer', { source: 'text' });
  await c.orc.send(c.s.id, 'hello there', { source: 'voice', speaker: 'guest' });
  await c.orc.send(c.s.id, '10 minutes', { source: 'text' });
  assert.equal(c.fpTexts.at(-1), 'set a timer 10 minutes', 'the owner\'s question survived the guest turn');

  const d = askSetup({ resolveSelection: async () => ({ action: 'ask', ask: 'For how long?', source: 'rule', decision: { gated: true } }) });
  const g = await d.orc.send(d.s.id, 'start a timer for the oven', { source: 'voice', speaker: 'guest' });
  assert.equal(g.reply, 'For how long?');
  await d.orc.send(d.s.id, '10 minutes', { source: 'text' });
  assert.equal(d.fpTexts.at(-1), '10 minutes', 'the guest request is not merged into the owner turn');
});

test('a guest turn does not become the owner\'s last skill groups', async () => {
  const c = askSetup();
  await c.orc.send(c.s.id, 'what time', { source: 'text' });
  const before = c.orc.getLastGroups(c.s.id);
  await c.orc.send(c.s.id, 'start a timer now', { source: 'voice', speaker: 'guest' });
  assert.deepEqual(c.orc.getLastGroups(c.s.id), before);
  await c.orc.send(c.s.id, 'do that again', { source: 'text' });
  assert.ok(!c.picks.at(-1).lastGroups.includes('timers'), 'the owner follow-up does not pick up the guest request');
});
