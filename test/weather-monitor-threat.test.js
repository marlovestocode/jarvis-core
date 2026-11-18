const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeatherAlertsMonitor } = require('../src/core/proactive/monitors/weather-alerts');

const MIN = 60000;
const threat = (level, kind = 'wind', etaHours = 2, reasons = ['x']) => ({ threat: { level, kind, etaHours, reasons }, polys: [], models: 4 });

test('weatherAlerts + threat: a model-driven warning is spoken once with kind and ETA; watch stays quiet; a higher level speaks again', async () => {
  let t = threat('watch');
  const mon = createWeatherAlertsMonitor({ getAlerts: async () => ({ alerts: [] }), getThreat: async () => t });
  const st = {};
  assert.equal(await mon.check({}, {}, st, 1e9), null, 'watch is HUD-only');
  t = threat('warning');
  const a = await mon.check({}, {}, st, 1e9 + 11 * MIN);
  assert.match(a.text, /damaging wind/); assert.match(a.text, /2 hours/);
  assert.equal(a.kind, 'info');
  assert.equal(await mon.check({}, {}, st, 1e9 + 22 * MIN), null, 'same level: not again');
  t = threat('severe');
  assert.ok(await mon.check({}, {}, st, 1e9 + 33 * MIN), 'level went up: speak again');
  t = threat('none', null, null, []);
  assert.equal(await mon.check({}, {}, st, 1e9 + 44 * MIN), null);
  t = threat('warning');
  assert.ok(await mon.check({}, {}, st, 1e9 + 55 * MIN), 'after it cleared, a new one is news again');
});

test('weatherAlerts + threat: an NWS-driven threat is not announced a second time; a failing threat lookup does not hide alerts', async () => {
  const mon = createWeatherAlertsMonitor({ getAlerts: async () => ({ alerts: [{ event: 'Tornado Warning', severity: 'Extreme', ends: 'T1' }] }), getThreat: async () => threat('extreme', 'alert', 0) });
  const st = {};
  const a = await mon.check({}, {}, st, 1e9);
  assert.match(a.text, /Tornado Warning/);
  assert.equal(await mon.check({}, {}, st, 1e9 + 11 * MIN), null);
  const mon2 = createWeatherAlertsMonitor({ getAlerts: async () => ({ alerts: [{ event: 'Flood Warning', severity: 'Severe', ends: 'T1' }] }), getThreat: async () => { throw new Error('no forecast'); } });
  assert.match((await mon2.check({}, {}, {}, 1e9)).text, /Flood Warning/);
});

test('weatherAlerts + threat: a US-only alerts error does not stop the model threat (non-US home)', async () => {
  const mon = createWeatherAlertsMonitor({ getAlerts: async () => { throw new Error('weather alerts are only available for the US'); }, getThreat: async () => threat('severe', 'storm', 0.5) });
  const a = await mon.check({}, {}, {}, 1e9);
  assert.match(a.text, /thunderstorms/); assert.match(a.text, /within the hour/);
});
