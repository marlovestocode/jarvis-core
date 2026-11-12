const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MONITORS, cleanMonitors, patchMonitors, clampNumber } = require('../src/core/proactive/monitor-config');
const { DEFAULTS } = require('../src/core/config');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createEngineRegistries } = require('../src/core/voice/engines');
const { applyPatch } = require('../src/core/settings');

const WANT = { timersSoon: { enabled: false, leadMin: 10 }, sysmon: { enabled: false, cpu: 90, ram: 90, disk: 95, temp: 85 } };

test('defaults are exact and deeply frozen', () => {
  assert.deepEqual(DEFAULT_MONITORS, WANT);
  assert.ok(Object.isFrozen(DEFAULT_MONITORS) && Object.isFrozen(DEFAULT_MONITORS.timersSoon) && Object.isFrozen(DEFAULT_MONITORS.sysmon));
  assert.ok(Object.isFrozen(DEFAULTS.proactive.monitors));
  assert.equal(DEFAULTS.proactive.cooldownMin, 15);
  assert.equal(DEFAULTS.proactive.maxPerHour, 6);
});

test('clampNumber rounds and clamps', () => {
  assert.equal(clampNumber(5.6, 1, 10), 6);
  assert.equal(clampNumber(-3, 1, 10), 1);
  assert.equal(clampNumber(99, 1, 10), 10);
});

test('cleanMonitors: missing, junk and out-of-range fall back or clamp', () => {
  assert.deepEqual(cleanMonitors(undefined), WANT);
  assert.deepEqual(cleanMonitors('junk'), WANT);
  assert.deepEqual(cleanMonitors(null), WANT);
  assert.deepEqual(cleanMonitors([1]), WANT);
  const m = cleanMonitors({ sysmon: { ram: 500, cpu: 'x', temp: 5, enabled: 'yes' }, timersSoon: 7, extra: {} });
  assert.equal(m.sysmon.ram, 100);
  assert.equal(m.sysmon.cpu, 90);
  assert.equal(m.sysmon.temp, 30);
  assert.equal(m.sysmon.enabled, false, 'non-boolean enabled falls back');
  assert.deepEqual(m.timersSoon, WANT.timersSoon);
  assert.equal('extra' in m, false);
  assert.equal(cleanMonitors({ timersSoon: { enabled: true, leadMin: 999 } }).timersSoon.leadMin, 120);
});

test('patchMonitors: known fields only, coerced and clamped', () => {
  const { monitors, errors } = patchMonitors(DEFAULT_MONITORS, { timersSoon: { enabled: 1, leadMin: 0 }, bogus: {}, sysmon: { nope: 1 } });
  assert.equal(monitors.timersSoon.enabled, true);
  assert.equal(monitors.timersSoon.leadMin, 1);
  assert.equal('bogus' in monitors, false);
  assert.equal('nope' in monitors.sysmon, false);
  assert.deepEqual(errors, []);
});

test('patchMonitors: non-finite number errors and is skipped', () => {
  const r = patchMonitors(DEFAULT_MONITORS, { sysmon: { ram: 'abc' } });
  assert.equal(r.errors.length, 1);
  assert.equal(r.monitors.sysmon.ram, 90);
});

test('results are fresh copies', () => {
  const a = cleanMonitors(undefined);
  a.sysmon.cpu = 1;
  const b = patchMonitors(DEFAULT_MONITORS, {}).monitors;
  b.timersSoon.leadMin = 99;
  assert.equal(DEFAULT_MONITORS.sysmon.cpu, 90);
  assert.equal(DEFAULT_MONITORS.timersSoon.leadMin, 10);
});

test('applyPatch: proactive monitors, cooldown and cap, input not mutated', () => {
  const providers = createRegistry(); providers.add(NullProvider);
  const engines = createEngineRegistries();
  const cur = { ...DEFAULTS, engines: { ...DEFAULTS.engines }, hotkeys: { ...DEFAULTS.hotkeys } };
  const { config, errors } = applyPatch(cur, { proactive: { monitors: { sysmon: { enabled: true, cpu: 70 } }, cooldownMin: 999, maxPerHour: 0 } }, { providers, engines });
  assert.equal(config.proactive.cooldownMin, 240);
  assert.equal(config.proactive.maxPerHour, 1);
  assert.equal(config.proactive.monitors.sysmon.enabled, true);
  assert.equal(config.proactive.monitors.sysmon.cpu, 70);
  assert.deepEqual(errors, []);
  assert.equal(cur.proactive.monitors.sysmon.enabled, false, 'input monitors unmutated');
  assert.equal(DEFAULT_MONITORS.sysmon.cpu, 90);
  const bad = applyPatch(cur, { proactive: { monitors: { sysmon: { ram: 'x' } } } }, { providers, engines });
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.config.proactive.monitors.sysmon.ram, 90);
});
