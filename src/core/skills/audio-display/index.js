// Sound output device, brightness, displays and night light. Setters read the value back and fail on a mismatch.
const { matchText, norm } = require('../../media/rank');
const { own } = require('../util');

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
const listWords = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a.at(-1)}`);

function createAudioDisplayTools({ host }) {
  const audioDevices = {
    name: 'audio_devices', risk: 'safe',
    hint: 'audio_devices: list sound outputs. audio_output_set: switch the default output ("headphones"). brightness_set: laptop panel brightness. displays_list: connected displays. night_light: blue light filter on or off. Say it is done only when the result says so; volume and mute are media_control.',
    description: 'List the sound output devices and which one is the default.',
    params: obj({}),
    async run() {
      const ds = await host.audioDevices();
      if (!ds.length) return 'I found no sound output devices.';
      return `Outputs: ${ds.map(d => d.name + (d.default ? ' (default)' : '')).join('; ')}.`;
    },
  };

  const audioOutputSet = {
    name: 'audio_output_set', risk: 'safe',
    hint: 'audio_output_set: see audio_devices.',
    description: 'Switch the default sound output device by name, e.g. "headphones" or "speakers".',
    params: obj({ name: { description: 'device name or a word from it, e.g. "headphones"', type: 'string' } }, ['name']),
    async run({ name } = {}) {
      const q = String(name || '').trim();
      if (!q) throw new Error('Which output device?');
      const ds = await host.audioDevices();
      const scored = ds.map(d => ({ d, s: norm(d.name) === norm(q) ? 1 : matchText(q, d.name) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s);
      if (!scored.length) throw new Error(`No sound output matches "${q}". Outputs: ${ds.map(d => d.name).join('; ') || 'none'}.`);
      const close = scored.filter(x => x.s >= scored[0].s - 0.05);
      if (close.length > 1 && scored[0].s < 1) throw new Error(`Which one: ${listWords(close.map(x => x.d.name))}?`);
      const target = scored[0].d;
      if (!(await host.audioSetDefault(target.id))) throw new Error(`Windows would not switch to ${target.name}`);
      const now = (await host.audioDevices()).find(d => d.default);
      if (!now || now.id !== target.id) throw new Error(`Windows did not switch: ${now ? now.name : 'another device'} is still the default output`);
      return `Sound output is now ${target.name}.`;
    },
  };

  const brightnessSet = {
    name: 'brightness_set', risk: 'safe',
    hint: 'brightness_set: see audio_devices.',
    description: 'Set the laptop screen brightness: percent (0-100) or by (a change such as -10). Built-in panels only.',
    params: obj({ percent: { description: 'brightness to set, 0 to 100', type: 'number' }, by: { description: 'change in percent points, e.g. -10; use this or percent', type: 'number' } }),
    async run({ percent, by } = {}) {
      if (!Number.isFinite(percent) && !Number.isFinite(by)) throw new Error('Say a percent, or by how much to change it');
      const cur = await host.brightness();
      if (cur === null) throw new Error('Brightness is not supported here: only laptop panels have it, and external monitors do not');
      const want = clamp(Number.isFinite(percent) ? percent : cur + by);
      await host.setBrightness(want);
      const got = await host.brightness();
      if (got === null || Math.abs(got - want) > 2) throw new Error(`The panel did not change: brightness is still at ${got === null ? 'an unknown level' : `${got}%`}`);
      return `Brightness is now ${got}%.`;
    },
  };

  const displaysList = {
    name: 'displays_list', risk: 'safe',
    hint: 'displays_list: see audio_devices.',
    description: 'List the connected displays: size and refresh rate.',
    params: obj({}),
    async run() {
      const ds = await host.displays();
      if (!ds.length) throw new Error('I cannot read the displays');
      return `Displays: ${ds.map(d => `${d.n}${d.primary ? ' (primary)' : ''}: ${d.w}x${d.h}${d.hz ? ` at ${d.hz} Hz` : ''}`).join('; ')}.`;
    },
  };

  const nightLight = {
    name: 'night_light', risk: 'safe',
    hint: 'night_light: see audio_devices.',
    description: 'Turn the Windows night light (blue light filter) on or off.',
    params: obj({ on: { description: 'true for on, false for off', type: 'boolean' } }, ['on']),
    async run({ on } = {}) {
      if (typeof on !== 'boolean') throw new Error('Say on or off');
      const set = await host.nightLight(on);
      if (set === null) throw new Error('Night light is not available from here on this PC');
      const now = await host.nightLight();
      if (now !== on) throw new Error(`Night light is still ${now ? 'on' : 'off'}`);
      return `Night light is ${on ? 'on' : 'off'}.`;
    },
  };

  return [audioDevices, audioOutputSet, brightnessSet, displaysList, nightLight];
}

function createGroup({ pc } = {}) {
  if (!pc) return null;
  return {
    id: 'audio-display',
    label: 'Sound output device, brightness, displays, night light',
    // "volume" and "mute" stay with media
    triggers: [
      { re: /\b(?:dim|brighten)\b.*\b(?:screen|display|monitor)\b|\b(?:dim|brighten) the (?:screen|display)\b|\b(?:screen|display) (?:is )?(?:too )?(?:bright|dim|dark)\b/i, w: 3 },
      { re: /\b(?:which|what|how many) (?:monitors|displays|screens)\b/i, w: 3 },
      { words: ['output device', 'output devices', 'speakers', 'headphones', 'sound output', 'audio output', 'brightness', 'dimmer', 'brighter', 'display', 'displays', 'night light', 'blue light'], w: 3 },
    ],
    tools: createAudioDisplayTools(pc).map(t => own(t)),
  };
}

module.exports = { createGroup, createAudioDisplayTools };
