// Integration: the REAL assembler + live/task providers + memory block + in-memory cortex. The hint that reaches recall is built only from
// content values (app name, task title): template words of display sentences ("window", "timer", "media") must not pull unrelated memories.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/facts');
const { createMemoryBlock } = require('../src/core/memory/block');
const { createAssembler } = require('../src/core/context/assemble');
const { liveProvider, taskProvider } = require('../src/core/context/providers');

function world(snap) {
  const cortex = open({ now: () => 1_700_000_000_000 });
  const memory = createMemory({ cortex });
  const block = createMemoryBlock({ cortex, memory, getConfig: () => ({ memory: { usePastChats: true } }) });
  const note = (text) => { const r = memory.propose({ text, sessionId: 's' }); memory.approve(r.id); };
  const live = { snapshot: () => snap };
  const tasks = { active: () => snap.task };
  const asm = createAssembler({ providers: [liveProvider({ live }), taskProvider({ tasks })] });
  const turn = async (text) => {
    const pkg = await asm.assemble({ text, speaker: 'owner', sessionId: 's', snap: live.snapshot() });
    return block.forTurn({ text, sessionId: 's', context: pkg.hint });
  };
  return { note, turn };
}

const JUNK = ['kitchen window is broken', 'pasta timer is set for eight minutes', 'media player settings are in the cupboard'];

test('template words of live display sentences never recall unrelated memories', async () => {
  const snap = { activeWindow: { app: 'Code' }, timers: { count: 1, nextInMs: 300000 }, media: { playing: true }, task: { id: 't1', title: 'Tidy Downloads', status: 'paused', done: 1, total: 3 } };
  const { note, turn } = world(snap);
  JUNK.forEach(note);
  for (const q of ['why does this keep crashing', 'fix the bug in this function', 'summarise this page for me']) {
    const out = await turn(q);
    assert.equal(out.memo, '', `${q} -> ${out.memo}`);
  }
});

test('a window/task title naming the project still helps a vague question', async () => {
  const snap = { activeWindow: { app: 'Code' }, task: { id: 't1', title: 'wallpaper project', status: 'running', done: 0, total: 2 } };
  const { note, turn } = world(snap);
  JUNK.forEach(note); note('The wallpaper project uses a bridge on port 47801');
  const out = await turn('what port does it use');
  assert.match(out.memo, /wallpaper project/);
  assert.ok(!/kitchen|pasta|media player/.test(out.memo));
});
