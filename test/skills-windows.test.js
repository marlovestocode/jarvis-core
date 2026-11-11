const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGroup } = require('../src/core/skills/windows');
const { createPcHost } = require('../src/core/pc/host');
const { createConfirm } = require('../src/core/pc/confirm');
const { createActionLog } = require('../src/core/pc/actions-log');
const { cortexOn } = require('./helpers/cortex');
const { createToolRunner } = require('../src/core/tools/registry');
const { PROTECTED } = require('../src/core/tools/pc');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createFakePcHost } = require('./helpers/fake-pc-host');

const W = (hwnd, pid, app, title, extra = {}) => ({ hwnd, pid, app, title, ...extra });
const TWO = [
  { n: 1, primary: true, x: 0, y: 0, w: 1920, h: 1080 },
  { n: 2, primary: false, x: 1920, y: 0, w: 2560, h: 1440 },
];

function setup(hostOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsw-'));
  const host = createFakePcHost({ windows: [W(1, 10, 'chrome', 'Docs - Chrome'), W(2, 11, 'Code', 'main.js')], ...hostOpts });
  const actionLog = createActionLog({ cortex: cortexOn(path.join(dir, 'a.log')) });
  const confirm = createConfirm({ actionLog });
  const group = createGroup({ pc: { host, confirm, actionLog, roots: [dir], getAllowlist: async () => [] } });
  const by = Object.fromEntries(group.tools.map(t => [t.name, t]));
  const runner = createToolRunner(group.tools);
  const ctx = { turn: { tainted: false } };
  const run = (name, args, c = ctx) => runner.run(name, args, c);
  return { host, group, by, run, confirm, actionLog, ctx };
}
const rectOf = (host, hwnd) => host.wins.find(w => w.hwnd === hwnd).rect;

test('windows group: five tools, strict schemas, only the hung-app one asks', () => {
  const { group } = setup();
  assert.equal(group.id, 'windows');
  assert.deepEqual(group.tools.map(t => t.name), ['window_arrange', 'window_to_monitor', 'desktop_switch', 'window_to_desktop', 'end_unresponsive_app']);
  for (const t of group.tools) assert.equal(t.params.additionalProperties, false, t.name);
  assert.deepEqual(group.tools.filter(t => t.risk === 'confirm').map(t => t.name), ['end_unresponsive_app']);
  assert.ok(group.tools.every(t => t.description.length < 220), 'descriptions stay short');
});

test('windows group: absent without a PC host', () => {
  assert.equal(createGroup({}), null);
});

test('windows: snap left asks the host for left and verifies the rect', async () => {
  const { host, run } = setup();
  const r = await run('window_arrange', { target: 'chrome', layout: 'left' });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Snapped Docs - Chrome to the left/);
  assert.deepEqual(host.calls.find(c => c[0] === 'place')[1], { hwnd: 1, layout: 'left' });
  assert.deepEqual(rectOf(host, 1), { x: 0, y: 0, w: 960, h: 1080 });
});

test('windows: every layout is verified against the work area', async () => {
  const { run } = setup();
  for (const layout of ['left', 'right', 'top_left', 'top_right', 'bottom_left', 'bottom_right', 'maximize', 'center', 'minimize', 'restore']) {
    const r = await run('window_arrange', { target: 'chrome', layout });
    assert.equal(r.ok, true, `${layout}: ${r.text}`);
  }
});

test('windows: a window that did not end up where asked is an error, not a success', async () => {
  const { run } = setup({ placeWrong: true });
  const r = await run('window_arrange', { target: 'chrome', layout: 'right' });
  assert.equal(r.ok, false);
  assert.match(r.text, /did not end up/);
});

test('windows: target omitted means the window in front', async () => {
  const { host, run } = setup({ foreground: 2 });
  const r = await run('window_arrange', { layout: 'maximize' });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /main\.js/);
  assert.equal(host.calls.find(c => c[0] === 'place')[1].hwnd, 2);
});

test('windows: layout outside the enum is refused', async () => {
  const { host, run } = setup();
  const r = await run('window_arrange', { target: 'chrome', layout: 'diagonal' });
  assert.equal(r.ok, false);
  assert.match(r.text, /Layouts: left, right, top_left/);
  assert.ok(!host.calls.some(c => c[0] === 'place'));
});

test('windows: unknown target says which windows exist', async () => {
  const { host, run } = setup();
  const r = await run('window_arrange', { target: 'zoom', layout: 'left' });
  assert.equal(r.ok, false);
  assert.match(r.text, /No open window matches "zoom"\. Open windows: .*Docs - Chrome.*main\.js/);
  assert.ok(!host.calls.some(c => c[0] === 'place'));
});

test('windows: monitor number out of range lists monitors', async () => {
  const { host, run } = setup({ monitors: TWO });
  const r = await run('window_to_monitor', { target: 'chrome', monitor: 3 });
  assert.equal(r.ok, false);
  assert.match(r.text, /Monitor 3 does not exist\. Monitors: 1 \(primary, 1920x1080\), 2 \(2560x1440\)\./);
  assert.ok(!host.calls.some(c => c[0] === 'moveToMonitor'));
});

test('windows: move to a monitor and to the next one, verified by position', async () => {
  const { host, run } = setup({ monitors: TWO });
  const a = await run('window_to_monitor', { target: 'chrome', monitor: 2 });
  assert.equal(a.ok, true, a.text);
  assert.match(a.text, /monitor 2/);
  assert.ok(rectOf(host, 1).x >= 1920);
  const b = await run('window_to_monitor', { target: 'chrome', monitor: 'next' });   // wraps back to 1
  assert.equal(b.ok, true, b.text);
  assert.ok(rectOf(host, 1).x < 1920);
});

test('windows: next monitor with a single monitor says so', async () => {
  const { run } = setup();
  const r = await run('window_to_monitor', { target: 'chrome', monitor: 'next' });
  assert.equal(r.ok, false);
  assert.match(r.text, /only one monitor/i);
});

test('windows: virtual desktops report unavailable instead of success', async () => {
  const { run } = setup({ desktops: false });
  const a = await run('desktop_switch', { to: 'next' });
  assert.equal(a.ok, false);
  assert.match(a.text, /Virtual desktops are not available on this Windows build/);
  const b = await run('window_to_desktop', { target: 'chrome', desktop: 2 });
  assert.equal(b.ok, false);
  assert.match(b.text, /Virtual desktops are not available/);
});

test('windows: desktop switch and move validate their arguments', async () => {
  const { host, run } = setup();
  assert.equal((await run('desktop_switch', { to: 'next' })).ok, true);
  assert.equal((await run('desktop_switch', { to: 3 })).ok, true);
  assert.equal((await run('desktop_switch', { to: 0 })).ok, false);
  assert.equal((await run('desktop_switch', { to: 'sideways' })).ok, false);
  assert.equal((await run('window_to_desktop', { target: 'chrome', desktop: 2 })).ok, true);
  assert.equal((await run('window_to_desktop', { target: 'chrome', desktop: 99 })).ok, false);
  assert.deepEqual(host.calls.filter(c => c[0] === 'desktopSwitch').map(c => c[1]), ['next', 3]);
});

const HUNG = [W(1, 10, 'frozenapp', 'Frozen App', { responding: false }), W(2, 11, 'chrome', 'Docs - Chrome', { responding: true }), W(3, 12, 'frozenapp', 'Frozen App 2', { responding: false })];

test('end_unresponsive_app: only a window the host reports responding:false', async () => {
  const { host, run } = setup({ windows: HUNG });
  const r = await run('end_unresponsive_app', { name: 'chrome' });
  assert.equal(r.ok, false);
  assert.match(r.text, /responding/i);
  assert.ok(!r.text.startsWith(NEEDS_OK));
  assert.ok(!host.calls.some(c => c[0] === 'kill'));
  // a window the host did not report on at all is not "hung" either
  const { run: run2 } = setup({ windows: [W(1, 10, 'frozenapp', 'Frozen App')] });
  assert.equal((await run2('end_unresponsive_app', { name: 'frozenapp' })).ok, false);
});

test('end_unresponsive_app: protected processes are refused', async () => {
  assert.ok(PROTECTED.has('explorer'));
  const { host, run } = setup({ windows: [W(1, 4, 'explorer', 'File Explorer', { responding: false })] });
  const r = await run('end_unresponsive_app', { name: 'explorer' });
  assert.equal(r.ok, false);
  assert.match(r.text, /won't end explorer/);
  assert.ok(!host.calls.some(c => c[0] === 'kill'));
});

test('end_unresponsive_app: confirm flow ends only the pids it proposed, after yes', async () => {
  const { host, run, confirm } = setup({ windows: HUNG });
  const r = await run('end_unresponsive_app', { name: 'frozenapp' });
  assert.equal(r.ok, true, r.text);
  assert.ok(r.text.startsWith(NEEDS_OK), r.text);
  assert.match(r.text, /not responding/);
  assert.ok(!host.calls.some(c => c[0] === 'kill'), 'nothing is ended before the yes');
  const reply = (await confirm.handle('yes')).reply;
  assert.match(reply, /Ended/);
  assert.deepEqual(host.calls.filter(c => c[0] === 'kill').map(c => c[1]).sort(), [10, 12]);
  assert.ok(!host.calls.some(c => c[0] === 'kill' && c[1] === 11), 'the healthy chrome pid is untouched');
});

test('end_unresponsive_app: a window that recovered before the yes is left running', async () => {
  const { host, run, confirm } = setup({ windows: HUNG });
  await run('end_unresponsive_app', { name: 'frozenapp' });
  host.wins.find(w => w.hwnd === 1).responding = true;
  host.wins.find(w => w.hwnd === 3).responding = true;
  const reply = (await confirm.handle('yes')).reply;
  assert.match(reply, /responding again/);
  assert.ok(!host.calls.some(c => c[0] === 'kill'));
});

test('end_unresponsive_app: tainted turn cannot start it', async () => {
  const { host, run } = setup({ windows: HUNG });
  const r = await run('end_unresponsive_app', { name: 'frozenapp' }, { turn: { tainted: true } });
  assert.equal(r.ok, false);
  assert.match(r.text, /won't start that from text I read/);
  assert.ok(!host.calls.some(c => c[0] === 'kill'));
});

// ---- typed host wrappers ----
function fakeRequest(answers = {}) {
  const sent = [];
  return { sent, request: async (cmd, args = {}) => { sent.push({ cmd, args }); const a = answers[cmd]; return typeof a === 'function' ? a(args) : a; } };
}

test('pc host: window commands are typed and their answers cleaned', async () => {
  const { request, sent } = fakeRequest({
    windows: [{ hwnd: 5, pid: 6, app: 'x', title: 't', responding: false, rect: { x: 1, y: 2, w: 3, h: 4 } }, { hwnd: 7, pid: 8, app: 'y', title: 'u', responding: 'no', rect: { x: 'a' } }],
    foreground: 5,
    monitors: [{ n: 1, primary: true, x: 0, y: 0, w: 1920, h: 1080 }, { n: 0, x: 0, y: 0, w: 1, h: 1 }],
    place: { ok: true, rect: { x: 0, y: 0, w: 960, h: 1080 }, state: 'normal' },
    moveToMonitor: { ok: true, rect: { x: 1970, y: 50, w: 800, h: 600 } },
    desktopSwitch: true, desktopMove: false,
  });
  const h = createPcHost({ request });
  assert.deepEqual(await h.windows(), [{ hwnd: 5, pid: 6, app: 'x', title: 't', responding: false, rect: { x: 1, y: 2, w: 3, h: 4 } }, { hwnd: 7, pid: 8, app: 'y', title: 'u' }]);
  assert.equal(await h.foreground(), 5);
  assert.deepEqual(await h.monitors(), [{ n: 1, primary: true, x: 0, y: 0, w: 1920, h: 1080 }]);
  assert.deepEqual(await h.place(5, 'left'), { ok: true, rect: { x: 0, y: 0, w: 960, h: 1080 }, state: 'normal' });
  assert.deepEqual(await h.moveToMonitor(5, 2), { ok: true, rect: { x: 1970, y: 50, w: 800, h: 600 } });
  assert.equal(await h.desktopSwitch('next'), true);
  assert.equal(await h.desktopMove(5, 2), false);
  assert.deepEqual(sent.map(s => s.cmd), ['windows', 'foreground', 'monitors', 'place', 'moveToMonitor', 'desktopSwitch', 'desktopMove']);
  assert.deepEqual(sent[3].args, { hwnd: 5, layout: 'left' });
});

test('pc host: bad window arguments are rejected before anything is sent', async () => {
  const { request, sent } = fakeRequest({});
  const h = createPcHost({ request });
  await assert.rejects(h.place(0, 'left'), /Bad hwnd/);
  await assert.rejects(h.place(5, 'diagonal'), /Bad layout/);
  await assert.rejects(h.moveToMonitor(5, 0), /Bad monitor/);
  await assert.rejects(h.desktopSwitch('sideways'), /Bad desktop/);
  await assert.rejects(h.desktopSwitch(21), /Bad desktop/);
  await assert.rejects(h.desktopMove(5, 0), /Bad desktop/);
  assert.deepEqual(sent, []);
});
