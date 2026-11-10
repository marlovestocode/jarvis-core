// Settings in <dir>/config.json, merged per key against DEFAULTS by typeof.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  provider: 'null',
  engines: Object.freeze({ stt: 'windows', tts: 'windows', wake: 'windows' }),
  wakeEnabled: false,
  micDeviceId: null,
  voiceRate: 1.0,
  hotkeys: Object.freeze({ chat: 'Control+Space', voice: 'Control+Shift+Space' }),
  port: 47801,
});

const NESTED = ['engines', 'hotkeys'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// micDeviceId defaults to null but holds a string: accept string or null.
function okValue(key, def, v) {
  if (key === 'micDeviceId') return v === null || typeof v === 'string';
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === typeof def;
}

function merge(raw) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = isObj(raw) ? raw[key] : undefined;
    if (NESTED.includes(key)) {
      out[key] = {};
      for (const [k, d] of Object.entries(def)) {
        const sv = isObj(v) ? v[k] : undefined;
        out[key][k] = typeof sv === typeof d ? sv : d;
      }
    } else {
      out[key] = v !== undefined && okValue(key, def, v) ? v : def;
    }
  }
  return out;
}

function loadConfig(dir) {
  const file = path.join(dir, 'config.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return merge({}); }
  try {
    return merge(JSON.parse(text));
  } catch {
    try { fs.renameSync(file, path.join(dir, 'config.broken.json')); } catch { /* best effort */ }
    return merge({});
  }
}

function saveConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merge(config), null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, loadConfig, saveConfig };
