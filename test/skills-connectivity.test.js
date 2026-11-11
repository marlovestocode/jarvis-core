const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGroup } = require('../src/core/skills/connectivity');
const { createPcHost } = require('../src/core/pc/host');
const { createConfirm } = require('../src/core/pc/confirm');
const { createActionLog } = require('../src/core/pc/actions-log');
const { createToolRunner } = require('../src/core/tools/registry');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createFakePcHost } = require('./helpers/fake-pc-host');

const PLANS = [
  { id: 'aaaa-balanced', name: 'Balanced', active: true },
  { id: 'bbbb-saver', name: 'Power saver', active: false },
  { id: 'cccc-high', name: 'High performance', active: false },
];

function setup(hostOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsc-'));
  const host = createFakePcHost({
    wifi: { enabled: true, ssid: 'HomeNet', signal: 82 },
    bluetooth: { enabled: true, devices: [{ name: 'WH-1000XM4', connected: true }, { name: 'Keyboard', connected: false }] },
    battery: { percent: 64, charging: false, minutes: 190 }, powerPlans: PLANS, focusAssist: false, ...hostOpts,
  });
  const actionLog = createActionLog({ file: path.join(dir, 'a.log') });
  const confirm = createConfirm({ actionLog });
  const group = createGroup({ pc: { host, confirm, actionLog } });
  const runner = createToolRunner(group.tools);
  const run = (name, args, ctx = { turn: { tainted: false } }) => runner.run(name, args, ctx);
  return { host, group, run, confirm, actionLog };
}

test('connectivity group: five tools, the two that can cut or change the system ask first', () => {
  const { group } = setup();
  assert.equal(group.id, 'connectivity');
  assert.deepEqual(group.tools.map(t => t.name), ['connectivity_status', 'wifi_set', 'bluetooth_set', 'power_plan_set', 'focus_assist']);
  assert.deepEqual(group.tools.filter(t => t.risk === 'confirm').map(t => t.name), ['wifi_set', 'power_plan_set']);
  assert.ok(group.tools.every(t => t.params.additionalProperties === false));
  assert.equal(createGroup({}), null);
});

test('connectivity_status: lists Wi-Fi, Bluetooth, battery, power plan and focus assist', async () => {
  const { run } = setup();
  const r = await run('connectivity_status', {});
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Wi-Fi: on, connected to HomeNet \(82%\)/);
  assert.match(r.text, /Bluetooth: on, connected: WH-1000XM4/);
  assert.match(r.text, /Battery: 64%, on battery, about 3 h 10 min left/);
  assert.match(r.text, /Power plan: Balanced/);
  assert.match(r.text, /Focus assist: off/);
});

test('connectivity_status: says "no battery" on desktops and that unreadable facts are unavailable', async () => {
  const { run } = setup({ battery: null, focusAssist: null });
  const r = await run('connectivity_status', {});
  assert.match(r.text, /Battery: no battery/);
  assert.match(r.text, /Focus assist: unavailable/);
  const { run: run2 } = setup({ battery: { percent: 100, charging: true, minutes: null }, wifi: { enabled: false, ssid: null, signal: null } });
  const r2 = await run2('connectivity_status', {});
  assert.match(r2.text, /Battery: 100%, charging/);
  assert.match(r2.text, /Wi-Fi: off/);
});

test('wifi_set: confirm, never runs from a tainted turn', async () => {
  const { host, run } = setup();
  const t = await run('wifi_set', { on: false }, { turn: { tainted: true } });
  assert.equal(t.ok, false);
  assert.match(t.text, /won't start that from text I read/);
  assert.ok(!host.calls.some(c => c[0] === 'setWifi'));
  const r = await run('wifi_set', { on: false });
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith(NEEDS_OK), r.text);
  assert.match(r.text, /Turn Wi-Fi off.*cut my own connection/);
  assert.ok(!host.calls.some(c => c[0] === 'setWifi'), 'nothing happens before the yes');
});

test('wifi_set: verifies state after yes, fails loudly otherwise', async () => {
  const { host, run, confirm } = setup();
  await run('wifi_set', { on: false });
  assert.match((await confirm.handle('yes')).reply, /Wi-Fi is off/);
  assert.equal((await host.wifi()).enabled, false);
  const { run: run2, confirm: c2 } = setup({ wifiStuck: true });
  await run2('wifi_set', { on: false });
  assert.match((await c2.handle('yes')).reply, /That did not work: .*Wi-Fi is still on/);
});

test('wifi_set: turning it on does not warn about the connection', async () => {
  const { run } = setup({ wifi: { enabled: false, ssid: null, signal: null } });
  const r = await run('wifi_set', { on: true });
  assert.doesNotMatch(r.text, /cut my own connection/);
});

test('bluetooth_set: verified or an error', async () => {
  const { host, run } = setup();
  const r = await run('bluetooth_set', { on: false });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Bluetooth is off/);
  assert.equal((await host.bluetooth()).enabled, false);
  const { run: stuck } = setup({ bluetoothStuck: true });
  const bad = await stuck('bluetooth_set', { on: false });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /Bluetooth is still on/);
});

test('power_plan_set: unknown plan lists plans', async () => {
  const { host, run } = setup();
  const r = await run('power_plan_set', { name: 'turbo' });
  assert.equal(r.ok, false);
  assert.match(r.text, /No power plan matches "turbo"\. Plans: Balanced, Power saver, High performance\./);
  assert.ok(!host.calls.some(c => c[0] === 'setPowerPlan'));
});

test('power_plan_set: confirm, changes only after yes and reads the active plan back', async () => {
  const { host, run, confirm } = setup();
  const t = await run('power_plan_set', { name: 'saver' }, { turn: { tainted: true } });
  assert.match(t.text, /won't start that from text I read/);
  const q = await run('power_plan_set', { name: 'saver' });
  assert.ok(q.text.startsWith(NEEDS_OK), q.text);
  assert.match(q.text, /Switch the power plan to Power saver/);
  assert.ok(!host.calls.some(c => c[0] === 'setPowerPlan'));
  assert.match((await confirm.handle('yes')).reply, /Power plan is now Power saver/);
  assert.deepEqual(host.calls.find(c => c[0] === 'setPowerPlan'), ['setPowerPlan', 'bbbb-saver']);
  const { run: stuck, confirm: c2 } = setup({ planStuck: true });
  await stuck('power_plan_set', { name: 'high' });
  assert.match((await c2.handle('yes')).reply, /That did not work: .*still Balanced/);
});

test('focus_assist: unsupported host returns an error, not success', async () => {
  const { run } = setup({ focusAssist: null });
  const r = await run('focus_assist', { on: true });
  assert.equal(r.ok, false);
  assert.match(r.text, /not available/i);
});

test('focus_assist: verified state', async () => {
  const { host, run } = setup({ focusAssist: false });
  const r = await run('focus_assist', { on: true });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Focus assist is on/);
  assert.equal(await host.focusAssist(), true);
  const { run: stuck } = setup({ focusAssist: false, focusStuck: true });
  const bad = await stuck('focus_assist', { on: true });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /still off/);
});

function fakeRequest(answers = {}) {
  const sent = [];
  return { sent, request: async (cmd, args = {}) => { sent.push({ cmd, args }); return answers[cmd]; } };
}

test('pc host: connectivity commands are typed and their answers cleaned', async () => {
  const { request, sent } = fakeRequest({
    wifi: { enabled: true, ssid: 'Net', signal: 70 }, setWifi: true,
    bluetooth: { enabled: true, devices: [{ name: 'Mouse', connected: true }, { connected: true }] }, setBluetooth: true,
    battery: { percent: 50, charging: true, minutes: null },
    powerPlans: [{ id: 'g1', name: 'Balanced', active: true }, { name: 'x' }], setPowerPlan: true, focusAssist: false,
  });
  const h = createPcHost({ request });
  assert.deepEqual(await h.wifi(), { enabled: true, ssid: 'Net', signal: 70 });
  assert.equal(await h.setWifi(false), true);
  assert.deepEqual(await h.bluetooth(), { enabled: true, devices: [{ name: 'Mouse', connected: true }] });
  assert.equal(await h.setBluetooth(true), true);
  assert.deepEqual(await h.battery(), { percent: 50, charging: true, minutes: null });
  assert.deepEqual(await h.powerPlans(), [{ id: 'g1', name: 'Balanced', active: true }]);
  assert.equal(await h.setPowerPlan('g1'), true);
  assert.equal(await h.focusAssist(), false);
  assert.deepEqual(sent.find(s => s.cmd === 'setWifi').args, { on: false });
  assert.deepEqual(sent.find(s => s.cmd === 'setPowerPlan').args, { id: 'g1' });
});

test('pc host: battery null means no battery; bad arguments are rejected before sending', async () => {
  const { request, sent } = fakeRequest({ battery: null, focusAssist: null });
  const h = createPcHost({ request });
  assert.equal(await h.battery(), null);
  assert.equal(await h.focusAssist(), null);
  sent.length = 0;
  await assert.rejects(h.setWifi('yes'), /Bad Wi-Fi value/);
  await assert.rejects(h.setBluetooth(1), /Bad Bluetooth value/);
  await assert.rejects(h.setPowerPlan(''), /Bad power plan id/);
  await assert.rejects(h.setPowerPlan('not a guid; rm'), /Bad power plan id/);
  await assert.rejects(h.focusAssist('on'), /Bad focus assist value/);
  assert.deepEqual(sent, []);
});
