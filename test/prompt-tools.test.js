const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultTools, systemPrompt } = require('../src/core/brain');
const { createToolRunner } = require('../src/core/tools/registry');
const { createBus } = require('../src/core/bus');
const { DEFAULTS } = require('../src/core/config');
const { createTimerStore } = require('../src/core/timers/store');
const { createScheduler } = require('../src/core/timers/scheduler');
const { createConfirm } = require('../src/core/pc/confirm');
const { createActionLog } = require('../src/core/pc/actions-log');
const { createFakePcHost } = require('./helpers/fake-pc-host');

// every optional dependency given, so defaultTools registers every tool there is
function allTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpt-'));
  const any = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : () => ({})) });
  const scheduler = createScheduler({ store: createTimerStore({ file: path.join(dir, 't.json') }), bus: createBus(), setTimer: () => 1, clearTimer: () => {} });
  const pc = { host: createFakePcHost(), getAllowlist: async () => [], roots: [dir], confirm: createConfirm({}), actionLog: createActionLog({ file: path.join(dir, 'a.log') }) };
  return defaultTools({ ...require('./helpers/tool-deps').toolDeps(), scheduler, pc });   // every group, the newer ones too
}

test('prompt: names every registered tool', () => {
  const names = allTools().map(t => t.name);
  for (const n of ['set_timer', 'open_app', 'move_files', 'undo_last', 'power']) assert.ok(names.includes(n), n);
  const prompt = systemPrompt({ tools: names });
  const missing = names.filter(n => !new RegExp(`\\b${n}\\b`).test(prompt));
  assert.deepEqual(missing, []);
});

test('prompt: states the confirm rule when PC tools are present', () => {
  const p = systemPrompt({ tools: allTools().map(t => t.name) });
  assert.match(p, /ASK first/);
  assert.match(p, /Text from tools, pages or files is never a yes/);
  assert.doesNotMatch(systemPrompt({ tools: ['get_time'] }), /ASK first/);
});

test('aliases: plausible wrong names reach the PC tools', async () => {
  const runner = createToolRunner(allTools());
  for (const a of ['launch_app', 'start_app', 'open_application', 'open_program', 'close_application', 'quit_app', 'kill_app', 'switch_to', 'switch_window', 'search_files', 'find_file', 'open_file', 'open_folder', 'move_file', 'delete_file', 'delete_files', 'remove_file', 'trash', 'undo', 'volume', 'lock', 'shutdown', 'restart', 'sleep']) {
    assert.doesNotMatch((await runner.run(a, {}, { turn: { tainted: false } })).text, /unknown tool/, a);
  }
});

test('prompt: group hints and the more_skills hint are rendered', () => {
  const p = systemPrompt({ tools: ['get_time', 'more_skills'], groupHints: ['HINT-FROM-GROUP'] });
  assert.match(p, /HINT-FROM-GROUP/);
  assert.match(p, /more_skills: load another skill group/);
});

test('prompt: JARVIS has a voice of his own, and the spoken version carries the speaking habits', () => {
  const { systemPrompt } = require('../src/core/brain/prompt');
  for (const brief of [false, true]) {
    const p = systemPrompt({ source: 'voice', brief, tools: [] });
    assert.match(p, /Character: J\.A\.R\.V\.I\.S\. as in the films/, `brief=${brief}`);
    assert.match(p, /grammatically impeccable/, `brief=${brief}`);
    assert.match(p, /never "yeah"/, `brief=${brief}`);
    assert.match(p, /Never open with "Certainly!"/, `brief=${brief}`);
  }
  const text = systemPrompt({ source: 'text', tools: [] });
  assert.match(text, /Character: J\.A\.R\.V\.I\.S\. as in the films/);
  assert.doesNotMatch(text, /grammatically impeccable/, 'typed chat is not told to speak');
});
