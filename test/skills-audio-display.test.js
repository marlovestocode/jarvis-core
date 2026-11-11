const test = require('node:test');
const assert = require('node:assert/strict');
const { createGroup } = require('../src/core/skills/audio-display');
const { createPcHost } = require('../src/core/pc/host');
const { createToolRunner } = require('../src/core/tools/registry');
const { createFakePcHost } = require('./helpers/fake-pc-host');

const DEVICES = [
  { id: '{0.0.0}.{aaa}', name: 'Speakers (Realtek Audio)', default: true },
  { id: '{0.0.0}.{bbb}', name: 'Headphones (Razer BlackShark)', default: false },
  { id: '{0.0.0}.{ccc}', name: 'Headphones (Bose QC35)', default: false },
  { id: '{0.0.0}.{ddd}', name: 'Monitor (NVIDIA High Definition Audio)', default: false },
];

function setup(hostOpts = {}) {
  const host = createFakePcHost({ audioDevices: DEVICES, brightness: 60, ...hostOpts });
  const group = createGroup({ pc: { host } });
  const runner = createToolRunner(group.tools);
  const run = (name, args) => runner.run(name, args, { turn: { tainted: false } });
  return { host, group, run };
}

test('audio-display group: five safe tools with strict schemas', () => {
  const { group } = setup();
  assert.equal(group.id, 'audio-display');
  assert.deepEqual(group.tools.map(t => t.name), ['audio_devices', 'audio_output_set', 'brightness_set', 'displays_list', 'night_light']);
  assert.ok(group.tools.every(t => t.risk === 'safe' && t.params.additionalProperties === false));
  assert.equal(createGroup({}), null);
});

test('audio-display: triggers do not claim volume or mute (those stay in media)', () => {
  const { group } = setup();
  const words = group.triggers.flatMap(t => t.words || []);
  assert.ok(!words.includes('volume') && !words.includes('mute'));
  assert.ok(!group.triggers.some(t => t.re && (t.re.test('mute spotify') || t.re.test('set the volume to 30'))));
});

test('audio_devices: lists the outputs and marks the default', async () => {
  const { run } = setup();
  const r = await run('audio_devices', {});
  assert.equal(r.ok, true);
  assert.match(r.text, /Speakers \(Realtek Audio\) \(default\)/);
  assert.match(r.text, /Headphones \(Bose QC35\)/);
});

test('audio_output_set: matches a device by fuzzy name and verifies the default changed', async () => {
  const { host, run } = setup();
  const r = await run('audio_output_set', { name: 'razer headphones' });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Sound output is now Headphones \(Razer BlackShark\)/);
  assert.deepEqual(host.calls.find(c => c[0] === 'audioSetDefault'), ['audioSetDefault', '{0.0.0}.{bbb}']);
  assert.equal((await host.audioDevices()).find(d => d.default).name, 'Headphones (Razer BlackShark)');
});

test('audio_output_set: ambiguous names ask which', async () => {
  const { host, run } = setup();
  const r = await run('audio_output_set', { name: 'headphones' });
  assert.equal(r.ok, false);
  assert.match(r.text, /Which one: .*Razer.*Bose/);
  assert.ok(!host.calls.some(c => c[0] === 'audioSetDefault'));
});

test('audio_output_set: unknown names list the devices; a change that did not stick is an error', async () => {
  const { run } = setup();
  const none = await run('audio_output_set', { name: 'bluetooth speaker xyz' });
  assert.equal(none.ok, false);
  assert.match(none.text, /No sound output matches .*Outputs: Speakers/);
  const { run: run2 } = setup({ audioStuck: true });
  const r = await run2('audio_output_set', { name: 'bose' });
  assert.equal(r.ok, false);
  assert.match(r.text, /is still the default/);
});

test('brightness_set: clamps to 0-100 and reads back', async () => {
  const { host, run } = setup();
  const hi = await run('brightness_set', { percent: 150 });
  assert.equal(hi.ok, true, hi.text);
  assert.match(hi.text, /Brightness is now 100%/);
  assert.equal(await host.brightness(), 100);
  const lo = await run('brightness_set', { by: -250 });
  assert.match(lo.text, /Brightness is now 0%/);
  const up = await run('brightness_set', { percent: 40 });
  const by = await run('brightness_set', { by: 15 });
  assert.match(by.text, /Brightness is now 55%/);
  assert.match(up.text, /40%/);
});

test('brightness_set: needs a percent or a change', async () => {
  const { run } = setup();
  const r = await run('brightness_set', {});
  assert.equal(r.ok, false);
  assert.match(r.text, /percent|by/);
});

test('brightness_set: external monitors report unsupported, not success', async () => {
  const { host, run } = setup({ brightness: null });
  const r = await run('brightness_set', { percent: 30 });
  assert.equal(r.ok, false);
  assert.match(r.text, /laptop panel|not supported/i);
  assert.ok(!host.calls.some(c => c[0] === 'setBrightness'));
});

test('brightness_set: a panel that ignores the change is an error', async () => {
  const { run } = setup({ brightnessStuck: true });
  const r = await run('brightness_set', { percent: 20 });
  assert.equal(r.ok, false);
  assert.match(r.text, /still at 60%/);
});

test('displays_list: size, refresh rate and the primary', async () => {
  const { run } = setup({ displays: [{ n: 1, primary: true, w: 2560, h: 1440, hz: 144 }, { n: 2, primary: false, w: 1920, h: 1080, hz: 60 }] });
  const r = await run('displays_list', {});
  assert.equal(r.ok, true);
  assert.match(r.text, /1 \(primary\): 2560x1440 at 144 Hz; 2: 1920x1080 at 60 Hz/);
});

test('night_light: verified state or an error', async () => {
  const { host, run } = setup({ nightLight: false });
  const r = await run('night_light', { on: true });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Night light is on/);
  assert.equal(await host.nightLight(), true);
  const { run: stuck } = setup({ nightLight: false, nightStuck: true });
  const bad = await stuck('night_light', { on: true });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /still off/);
  const { run: none } = setup({ nightLight: null });
  const un = await none('night_light', { on: true });
  assert.equal(un.ok, false);
  assert.match(un.text, /not available/i);
});

function fakeRequest(answers = {}) {
  const sent = [];
  return { sent, request: async (cmd, args = {}) => { sent.push({ cmd, args }); const a = answers[cmd]; if (a instanceof Error) throw a; return a; } };
}

test('pc host: audio and display commands are typed and their answers cleaned', async () => {
  const { request, sent } = fakeRequest({
    audioDevices: [{ id: 'a', name: 'Speakers', default: true }, { id: 5 }, { name: 'x' }],
    audioSetDefault: true, brightness: 70, setBrightness: 40,
    displays: [{ n: 1, primary: true, w: 1920, h: 1080, hz: 60 }, { n: 'x' }], nightLight: true,
  });
  const h = createPcHost({ request });
  assert.deepEqual(await h.audioDevices(), [{ id: 'a', name: 'Speakers', default: true }]);
  assert.equal(await h.audioSetDefault('a'), true);
  assert.equal(await h.brightness(), 70);
  assert.equal(await h.setBrightness(40.4), 40);
  assert.deepEqual(await h.displays(), [{ n: 1, primary: true, w: 1920, h: 1080, hz: 60 }]);
  assert.equal(await h.nightLight(), true);
  assert.equal(await h.nightLight(false), true);
  assert.deepEqual(sent.find(s => s.cmd === 'setBrightness').args, { percent: 40 });
  assert.deepEqual(sent.filter(s => s.cmd === 'nightLight').map(s => s.args), [{}, { on: false }]);
});

test('pc host: bad audio and display arguments are rejected before anything is sent', async () => {
  const { request, sent } = fakeRequest({});
  const h = createPcHost({ request });
  await assert.rejects(h.audioSetDefault(''), /Bad device id/);
  await assert.rejects(h.setBrightness(101), /Bad brightness/);
  await assert.rejects(h.setBrightness(NaN), /Bad brightness/);
  await assert.rejects(h.nightLight('yes'), /Bad night light/);
  assert.deepEqual(sent, []);
});
