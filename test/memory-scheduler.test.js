const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/cortex');
const { createSessionStore } = require('../src/core/session');
const { createChats } = require('../src/core/memory/chats');
const { createCaptureScheduler } = require('../src/core/memory/scheduler');

const u = content => ({ role: 'user', content });
const a = content => ({ role: 'assistant', content });
const READY = [u('one'), a('a'), u('two'), a('b')];

function setup({ autoCapture = true, idle = true, run } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmems-'));
  const sessions = createSessionStore(dir);
  const cortex = open({});
  const chats = createChats({ cortex, sessions });
  const cfg = { memory: { autoCapture } };
  const state = { idle, t: Date.now() };
  const ran = [];
  const notes = [];
  const extractor = {
    async run(s, opts) {
      ran.push(s.id);
      if (run) return run(s, opts);
      chats.upsertSummary({ sessionId: s.id, title: s.title, n: s.messages.length, summary: 'We talked about ' + s.title, topics: [] });
      return { summary: true, proposed: 2, entities: 0 };
    },
  };
  const sched = createCaptureScheduler({ sessions, extractor, chats, isIdle: () => state.idle, getConfig: () => cfg,
    notify: (title, body) => notes.push([title, body]), now: () => state.t });
  const chat = (msgs, title) => { const s = sessions.create(); s.messages.push(...msgs); if (title) s.messages[0].content = title; sessions.save(s); return s; };
  return { sessions, cortex, chats, cfg, state, ran, notes, sched, chat };
}

test('memory-scheduler: readiness — ≥ 4 messages, ≥ 2 from the user, not already summarized', () => {
  const { sched, chat, chats } = setup();
  assert.equal(sched.ready(chat([u('a'), a('b'), a('c')])), false);
  assert.equal(sched.ready(chat([u('a'), a('b'), a('c'), a('d')])), false, 'one user message');
  const s = chat(READY);
  assert.equal(sched.ready(s), true);
  chats.upsertSummary({ sessionId: s.id, title: 't', n: 4, summary: 'We talked about it', topics: [] });
  assert.equal(sched.ready(s), false, 'summary newer than the chat');
});

test('memory-scheduler: a chat switch triggers the previous session', async () => {
  const { sched, chat, ran, notes } = setup();
  const s = chat(READY);
  sched.onSwitch(s.id);
  await sched.tick();
  assert.deepEqual(ran, [s.id]);
  assert.deepEqual(notes, [['JARVIS', '2 new things to review in Memory']]);
});

test('memory-scheduler: 10 minutes idle triggers the newest chat', async () => {
  const { sched, chat, ran, state } = setup();
  const s = chat(READY);
  await sched.tick();
  assert.deepEqual(ran, []);
  state.t = Date.now() + 10 * 60000 + 1;
  await sched.tick();
  assert.deepEqual(ran, [s.id]);
});

test('memory-scheduler: startup sweep is newest first, max 5', async () => {
  const { sched, chat, ran } = setup();
  const ids = [];
  for (let i = 0; i < 7; i++) { ids.push(chat(READY).id); await new Promise(r => setTimeout(r, 2)); }
  sched.sweep();
  for (let i = 0; i < 8; i++) await sched.tick();
  assert.deepEqual(ran, ids.reverse().slice(0, 5));
});

test('memory-scheduler: not idle → waits', async () => {
  const { sched, chat, ran, state } = setup({ idle: false });
  const s = chat(READY);
  sched.onSwitch(s.id);
  await sched.tick();
  assert.deepEqual(ran, []);
  state.idle = true;
  await sched.tick();
  assert.deepEqual(ran, [s.id]);
});

test('memory-scheduler: a turn start aborts the job and the session is retried later', async () => {
  let sched;
  let first = true;
  const h = setup({
    run: async (s, { signal }) => {
      if (first) {
        first = false;
        sched.abort();
        assert.equal(signal.aborted, true);
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return { summary: true, proposed: 0, entities: 0 };
    },
  });
  sched = h.sched;
  const s = h.chat(READY);
  sched.onSwitch(s.id);
  await sched.tick();
  await sched.tick();
  assert.deepEqual(h.ran, [s.id, s.id]);
  assert.deepEqual(h.notes, [], 'nothing proposed, no notification');
});

test('memory-scheduler: a chat deleted mid-job leaves no chat node', async () => {
  let h;
  h = setup({
    run: async (s, { alive }) => {
      h.sessions.remove(s.id);
      if (!alive()) return { summary: false, proposed: 0, entities: 0, gone: true };
      h.chats.upsertSummary({ sessionId: s.id, title: 't', n: 4, summary: 'We talked about it', topics: [] });
      return { summary: true, proposed: 0, entities: 0 };
    },
  });
  const s = h.chat(READY);
  h.sched.onSwitch(s.id);
  await h.sched.tick();
  assert.equal(h.chats.find(s.id), null);
});

test('memory-scheduler: one notification per batch', async () => {
  const { sched, chat, notes } = setup();
  const a1 = chat(READY), a2 = chat(READY);
  sched.onSwitch(a1.id); sched.onSwitch(a2.id);
  await sched.tick();
  assert.deepEqual(notes, [], 'the batch is not over');
  await sched.tick();
  assert.deepEqual(notes, [['JARVIS', '4 new things to review in Memory']]);
});

test('memory-scheduler: autoCapture off → no calls', async () => {
  const { sched, chat, ran, state } = setup({ autoCapture: false });
  const s = chat(READY);
  sched.onSwitch(s.id); sched.sweep();
  state.t = Date.now() + 20 * 60000;
  await sched.tick();
  assert.deepEqual(ran, []);
});

test('memory-scheduler: an extractor error is logged and the queue moves on', async () => {
  const { sched, chat, ran } = setup({ run: async () => { throw new Error('model down'); } });
  const s1 = chat(READY), s2 = chat(READY);
  sched.onSwitch(s1.id); sched.onSwitch(s2.id);
  await sched.tick(); await sched.tick();
  assert.deepEqual(ran, [s1.id, s2.id]);
  assert.equal(sched.stats().failed, 2);
});

test('memory-scheduler: a deleted summary or a wipe is not undone by capture (floor)', async () => {
  const { sched, chat, chats, ran, state } = setup();
  const s = chat(READY);
  await new Promise(r => setTimeout(r, 5));
  chats.upsertSummary({ sessionId: s.id, title: 't', n: 4, summary: 'We talked about it', topics: [] });
  chats.forgetSummary(s.id);
  assert.equal(sched.ready(s), false, 'the user deleted this summary');
  s.messages.push(u('three'), a('c')); s.updated = Date.now() + 5;
  assert.equal(sched.ready(s), true, 'new messages after the delete make it ready again');
  const t = chat(READY);
  await new Promise(r => setTimeout(r, 5));   // save() can stamp a chat 1 ms ahead of the clock
  chats.setFloor();
  assert.equal(sched.ready(sessionsLoad(t)), false, 'after a wipe old chats are not re-read');
  sched.sweep(); state.t = Date.now() + 20 * 60000; await sched.tick();
  assert.deepEqual(ran, []);
  function sessionsLoad(x) { return x; }
});
