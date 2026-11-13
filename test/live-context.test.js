const test = require('node:test');
const assert = require('node:assert/strict');
const { liveContext } = require('../src/core/livestate/context');
const { open } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/facts');
const { createMemoryBlock } = require('../src/core/memory/block');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { DEFAULTS } = require('../src/core/config');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('liveContext: app, window title and active task become one short line; nothing else leaks in', () => {
  const snap = { t: 1, voice: 'thinking', activeWindow: { app: 'Code', title: 'wallpaper-core' }, task: { id: 't1', title: 'Tidy Downloads', status: 'paused' }, media: { playing: true }, tools: [{ name: 'delete_to_recycle_bin' }], confirm: { summary: 'delete 3 files' } };
  const c = liveContext(snap);
  assert.match(c, /Code/);
  assert.match(c, /wallpaper-core/);
  assert.match(c, /Tidy Downloads/);
  assert.doesNotMatch(c, /delete/);   // tool names and confirm text are not memory queries
  assert.ok(c.length <= 300);
});

test('liveContext: empty, malformed or hostile snapshots give an empty string and never throw', () => {
  for (const s of [null, undefined, {}, [], 'x', { activeWindow: 5 }, { task: { title: 7 } }, { activeWindow: { app: {} } }]) assert.equal(liveContext(s), '');
  const long = liveContext({ task: { title: 'x'.repeat(5000) } });
  assert.ok(long.length <= 300);
});

test('liveContext: a title is used only when the snapshot carries it (the source drops it when the setting is off)', () => {
  assert.equal(liveContext({ activeWindow: { app: 'Chrome' } }), 'Chrome');
});

function world() {
  const cortex = open({ now: () => 1_700_000_000_000 });
  const memory = createMemory({ cortex });
  const block = createMemoryBlock({ cortex, memory, getConfig: () => ({ memory: { usePastChats: true } }) });
  return { cortex, memory, block };
}

test('context reaches recall: a vague question is answered from what is on screen (and not without it)', async () => {
  const { memory, block } = world();
  const note = text => { const r = memory.propose({ text, sessionId: 's' }); memory.approve(r.id); };
  note('The wallpaper project uses a bridge on port 47801');
  note('Rex has a vet visit in March');
  const without = await block.forTurn({ text: 'what port does it use' });
  const withCtx = await block.forTurn({ text: 'what port does it use', context: liveContext({ activeWindow: { app: 'Code', title: 'wallpaper project' } }) });
  assert.match(withCtx.memo, /wallpaper project/);
  assert.ok(!/vet visit/.test(withCtx.memo));
  assert.ok(withCtx.ids.length >= without.ids.length);
});

function orcWith({ memoryBlock, live }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-'));
  const providers = createRegistry();
  providers.add(NullProvider);
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  providers.add(fp);
  const sessions = createSessionStore(dir);
  const orc = createOrchestrator({ bus: createBus(), sessions, providers, tools: null, getConfig: () => ({ ...DEFAULTS, provider: fp.id }), memoryBlock, live });
  return { orc };
}

function spyBlock() {
  const calls = [];
  return { calls, forTurn: async o => { calls.push(o); return { memo: '', ids: [] }; }, afterTurn() {}, onUserMessage() {} };
}
const liveWith = snap => ({ snapshot: () => snap });

test('orchestrator passes the live context to recall for the owner', async () => {
  const block = spyBlock();
  const { orc } = orcWith({ memoryBlock: block, live: liveWith({ activeWindow: { app: 'Code', title: 'wallpaper' } }) });
  await orc.send(null, 'what port does it use', { source: 'text' });
  assert.equal(block.calls.length, 1);
  assert.match(block.calls[0].context, /wallpaper/);
});

test('orchestrator: a guest turn recalls nothing, so no live context is used', async () => {
  const block = spyBlock();
  const { orc } = orcWith({ memoryBlock: block, live: liveWith({ activeWindow: { app: 'Code', title: 'wallpaper' } }) });
  await orc.send(null, 'what port does it use', { source: 'voice', speaker: 'guest' });
  assert.equal(block.calls.length, 0);
});

test('orchestrator: a throwing live snapshot or context builder leaves recall running without context', async () => {
  const block = spyBlock();
  const { orc } = orcWith({ memoryBlock: block, live: { snapshot: () => { throw new Error('boom'); } } });
  await orc.send(null, 'hello there friend', { source: 'text' });
  assert.equal(block.calls.length, 1);
  assert.ok(!block.calls[0].context);
});

// ---- G2: "continue where we left off" ----------------------------------------------------------------------------------------

function worldWithChats() {
  const w = world();
  const chat = (id, summary, title, topics) => {
    const src = w.cortex.source.add({ kind: 'model', ref: `history/${id}.json` });
    return w.cortex.node.upsert({ kind: 'chat', key: `chat:${id}`, text: summary, data: { title, n: 4, topics }, source: src }).id;
  };
  return { ...w, chat };
}

test('continue: "where we left off" recalls the newest earlier chat, not random facts that share the words', async () => {
  let t = 1_700_000_000_000;
  const cortex = open({ now: () => t });
  const memory = createMemory({ cortex });
  const block = createMemoryBlock({ cortex, memory, getConfig: () => ({ memory: { usePastChats: true } }) });
  const chat = (id, summary, title, topics) => cortex.node.upsert({ kind: 'chat', key: `chat:${id}`, text: summary, data: { title, n: 4, topics }, source: cortex.source.add({ kind: 'model', ref: `history/${id}.json` }) }).id;
  const r = memory.propose({ text: 'I left my keys off the hook and we left the gym early', sessionId: 'x' }); memory.approve(r.id);
  chat('old', 'Planned a birthday party menu with tacos', 'Party menu', ['party']); t += 86_400_000;
  chat('new', 'Worked on the wallpaper bridge: SSE stream and port 47801 handling', 'Wallpaper bridge', ['wallpaper', 'bridge']); t += 1000;
  const out = await block.forTurn({ text: 'continue where we left off', sessionId: 'now' });
  assert.match(out.memo, /wallpaper bridge/i);
  assert.ok(!/keys off the hook/.test(out.memo));
});

test('continue: the chat being written now is never "where we left off"', async () => {
  const { block, chat } = worldWithChats();
  chat('now', 'Current chat about the wallpaper bridge', 'Now', ['wallpaper']);
  const out = await block.forTurn({ text: 'pick up where we left off', sessionId: 'now' });
  assert.equal(out.memo, '');
});

test('continue: with an active task or window the hint is used too; with nothing to go on the memo is empty', async () => {
  const { block } = worldWithChats();
  assert.deepEqual(await block.forTurn({ text: 'carry on', sessionId: 's' }), { memo: '', ids: [] });
});

test('continue: a message that merely contains the words is an ordinary question', async () => {
  const { block, chat } = worldWithChats();
  chat('old', 'Wallpaper bridge notes', 'Wallpaper bridge', ['wallpaper']);
  const out = await block.forTurn({ text: 'how do I continue a sourdough starter', sessionId: 's' });
  assert.equal(out.memo, '');
});

test('orchestrator passes the session id to recall', async () => {
  const block = spyBlock();
  const { orc } = orcWith({ memoryBlock: block, live: liveWith({}) });
  const r = await orc.send(null, 'continue where we left off', { source: 'text' });
  assert.equal(block.calls[0].sessionId, r.sessionId);
});
