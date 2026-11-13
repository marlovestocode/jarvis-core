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
