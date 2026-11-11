// activity_log (W2 §6, plan E16) and tool failure rates from the cortex history (E15).
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cortexOn } = require('./helpers/cortex');
const { createActionLog } = require('../src/core/pc/actions-log');
const { createToolHistory } = require('../src/core/self/tool-history');
const { createPlayLog } = require('../src/core/music/log');
const { createActivityTool } = require('../src/core/tools/activity');
const { createSelfTools } = require('../src/core/tools/self');
const { createGroup } = require('../src/core/skills/self');

const NOW = Date.UTC(2026, 10, 11, 18);
const H = 3600e3, DAY = 24 * H;
function world() {
  const c = cortexOn();
  let t = NOW - 5 * H;
  const clock = () => t;
  const actionLog = createActionLog({ cortex: c, now: clock });
  const toolHistory = createToolHistory({ cortex: c, now: clock });
  const playLog = createPlayLog({ cortex: c, now: () => NOW });
  actionLog.write({ what: 'move_files', args: {}, result: 'Moved 3 files to Documents.', ok: true, undo: [{ from: 'a', to: 'b' }] });
  toolHistory.record({ name: 'web_search', ok: true, ms: 300, args: { query: 'weather' } });
  t = NOW - 2 * H;
  actionLog.write({ what: 'close_app', args: {}, result: 'Chrome is in use.', ok: false });
  toolHistory.record({ name: 'get_weather', ok: false, ms: 900, args: {} });
  toolHistory.record({ name: 'web_search', ok: true, ms: 200, args: {} });
  t = NOW - 3 * DAY;
  actionLog.write({ what: 'focus', args: {}, result: 'Focused Code.', ok: true });
  toolHistory.record({ name: 'get_weather', ok: false, ms: 900, args: {} });
  for (let i = 0; i < 3; i++) playLog.add({ videoId: 'aaaaaaaaaaa', title: 'One', artist: 'Band', startedAt: NOW - (3 - i) * H, listenedMs: 200000, duration: 200, reason: 'ended' });
  playLog.add({ videoId: 'bbbbbbbbbbb', title: 'Two', artist: 'Other', startedAt: NOW - 30 * 60e3, listenedMs: 200000, duration: 200, reason: 'ended' });
  const tool = createActivityTool({ actionLog, toolHistory, playLog, now: () => NOW });
  return { c, tool, actionLog, toolHistory, playLog };
}

test('activity_log: actions of today, newest first, with failures marked', async () => {
  const out = await world().tool.run({ what: 'actions' });
  assert.match(out, /close_app: Chrome is in use\. \(FAILED\)[\s\S]*move_files: Moved 3 files to Documents\./);
  assert.doesNotMatch(out, /Focused Code/);
});

test('activity_log: tools — counts and the failures of the week', async () => {
  const out = await world().tool.run({ what: 'tools', period: 'week' });
  assert.match(out, /4 tool calls/);
  assert.match(out, /web_search ×2/);
  assert.match(out, /get_weather ×2 \(2 failed\)/);
});

test('activity_log: music — plays and top tracks', async () => {
  const out = await world().tool.run({ what: 'music' });
  assert.match(out, /4 plays/);
  assert.match(out, /One - Band ×3/);
});

test('activity_log: all three by default, at most 1,500 chars, untrusted', async () => {
  const w = world();
  for (let i = 0; i < 200; i++) w.actionLog.write({ what: 'focus', args: {}, result: 'Focused a window with a long name '.repeat(3), ok: true });
  const out = await w.tool.run({});
  assert.match(out, /Actions/); assert.match(out, /Tools/); assert.match(out, /Music/);
  assert.ok(out.length <= 1500, String(out.length));
  assert.equal(w.tool.untrusted, true);
  assert.equal(w.tool.risk, 'safe');
});

test('activity_log: nothing logged says so', async () => {
  const c = cortexOn();
  const tool = createActivityTool({ actionLog: createActionLog({ cortex: c }), toolHistory: createToolHistory({ cortex: c }), playLog: createPlayLog({ cortex: c }), now: () => NOW });
  assert.match(await tool.run({ what: 'actions' }), /No actions today/);
});

test('self group: activity_log only when the app gives it the history', () => {
  const { actionLog, toolHistory, playLog } = world();
  assert.ok(!createGroup({ self: {} }).tools.some(t => t.name === 'activity_log'));
  const g = createGroup({ self: { toolHistory, activity: { actionLog, playLog } } });
  const t = g.tools.find(x => x.name === 'activity_log');
  assert.ok(t && t.untrusted);
  assert.ok(t.aliases.includes('what_did_you_do'));
  assert.ok(g.triggers.some(tr => tr.re?.test('what did you do for me today')));
});

test('self_diagnostics: tool runs come from the history and survive a restart', async () => {
  const { toolHistory } = world();
  const diag = createSelfTools({ toolHistory, now: () => NOW }).find(t => t.name === 'self_diagnostics');
  const freshRunner = { catalog: { missing: [], groups: [], tools: [] }, stats: () => new Map() };   // a new start: no in-memory counts
  const out = await diag.run({}, { skills: freshRunner });
  assert.match(out, /tool runs: get_weather failed 2 of 2 \(100%\)/);
});
