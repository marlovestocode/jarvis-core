const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonitorTools } = require('../src/core/tools/monitors');
const { applyPatch } = require('../src/core/settings');
const { DEFAULTS } = require('../src/core/config');
const { loadGroups } = require('../src/core/skills');
const { toolDeps } = require('./helpers/tool-deps');

// a store behind the same settings path the app uses (applyPatch), so clamping is the real one
function setup({ errors = [] } = {}) {
  let config = DEFAULTS;
  const patches = [];
  const applySettings = patch => {
    patches.push(patch);
    if (errors.length) return errors;
    const r = applyPatch(config, patch, { providers: { get: () => null, list: () => [] }, engines: {} });
    config = r.config;
    return r.errors;
  };
  const [tool] = createMonitorTools({ getConfig: () => config, applySettings });
  return { tool, patches, cfg: () => config.proactive.monitors };
}

test('monitor_set: enabling timer heads-ups with a lead time', async () => {
  const { tool, patches, cfg } = setup();
  const out = await tool.run({ monitor: 'timers', enabled: true, leadMin: 15 });
  assert.deepEqual(patches, [{ proactive: { monitors: { timersSoon: { enabled: true, leadMin: 15 } } } }]);
  assert.equal(out, 'Upcoming-timer heads-ups are on, 15 minutes ahead.');
  assert.equal(cfg().timersSoon.leadMin, 15);
});

test('monitor_set: leadMin alone turns the monitor on, 1 minute is singular', async () => {
  const { tool, patches } = setup();
  assert.equal(await tool.run({ monitor: 'timers', leadMin: 1 }), 'Upcoming-timer heads-ups are on, 1 minute ahead.');
  assert.equal(patches[0].proactive.monitors.timersSoon.enabled, true);
});

test('monitor_set: a ram limit sets ram and enables the system monitor', async () => {
  const { tool, patches, cfg } = setup();
  const out = await tool.run({ monitor: 'system', metric: 'ram', limit: 85 });
  assert.deepEqual(patches, [{ proactive: { monitors: { sysmon: { enabled: true, ram: 85 } } } }]);
  assert.equal(out, 'RAM warnings are on at 85%.');
  assert.equal(cfg().sysmon.ram, 85);
});

test('monitor_set: other metrics are worded in the same style', async () => {
  const { tool } = setup();
  assert.equal(await tool.run({ monitor: 'system', metric: 'cpu', limit: 80 }), 'CPU warnings are on at 80%.');
  assert.equal(await tool.run({ monitor: 'system', metric: 'disk', limit: 92 }), 'Disk warnings are on at 92%.');
  assert.equal(await tool.run({ monitor: 'system', metric: 'temp', limit: 85 }), 'Temperature warnings are on at 85°C.');
});

test('monitor_set: disabling', async () => {
  const { tool, patches, cfg } = setup();
  await tool.run({ monitor: 'system', enabled: true });
  assert.equal(await tool.run({ monitor: 'system', enabled: false }), 'System warnings are off.');
  assert.deepEqual(patches[1], { proactive: { monitors: { sysmon: { enabled: false } } } });
  assert.equal(cfg().sysmon.enabled, false);
  assert.equal(await tool.run({ monitor: 'timers', enabled: false }), 'Upcoming-timer heads-ups are off.');
});

test('monitor_set: enabling the system monitor without a limit reports the stored default', async () => {
  const { tool } = setup();
  assert.equal(await tool.run({ monitor: 'system', enabled: true }), 'System warnings are on: CPU 90%, RAM 90%, disk 95%, temperature 85°C.');
});

test('monitor_set: the sentence reports the value actually stored after clamping', async () => {
  const { tool, cfg } = setup();
  assert.equal(await tool.run({ monitor: 'system', metric: 'ram', limit: 500 }), 'RAM warnings are on at 100%.');
  assert.equal(cfg().sysmon.ram, 100);
  assert.equal(await tool.run({ monitor: 'timers', leadMin: 9999 }), 'Upcoming-timer heads-ups are on, 120 minutes ahead.');
});

test('monitor_set: bad requests throw a clear message and change nothing', async () => {
  const { tool, patches } = setup();
  await assert.rejects(() => tool.run({ monitor: 'disk', enabled: true }), /timers.*system/);
  await assert.rejects(() => tool.run({ enabled: true }), /timers.*system/);
  await assert.rejects(() => tool.run({ monitor: 'system', limit: 85 }), /metric/);
  await assert.rejects(() => tool.run({ monitor: 'timers' }), /enabled|leadMin|limit/);
  await assert.rejects(() => tool.run({ monitor: 'system', metric: 'ram' }), /enabled|limit/);
  await assert.rejects(() => tool.run({ monitor: 'system', metric: 'gpu', limit: 5 }), /cpu.*ram.*disk.*temp/);
  await assert.rejects(() => tool.run({ monitor: 'timers', limit: 5 }), /system/);
  await assert.rejects(() => tool.run({ monitor: 'system', leadMin: 5 }), /timers/);
  assert.deepEqual(patches, []);
});

test('monitor_set: an applySettings error list throws its first message', async () => {
  const { tool } = setup({ errors: ['Bad sysmon.ram: expected a number', 'second'] });
  await assert.rejects(() => tool.run({ monitor: 'system', metric: 'ram', limit: 85 }), /^Error: Bad sysmon\.ram: expected a number$/);
});

test('monitors group: loads with the shared tool deps, and is missing without applySettings', () => {
  const groups = loadGroups(toolDeps());
  assert.deepEqual(groups.missing, []);
  const g = groups.find(x => x.id === 'monitors');
  assert.ok(g && g.tools.some(t => t.name === 'monitor_set'));
  assert.ok(g.triggers.some(t => t.words?.includes('proactive')));
  assert.ok(g.triggers.some(t => t.re?.test('warn me if the ram gets high')));
  assert.ok(loadGroups({ ...toolDeps(), applySettings: undefined }).missing.some(m => m.id === 'monitors'));
});
