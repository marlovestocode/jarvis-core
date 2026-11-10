// Settings in <dir>/config.json, merged per key against DEFAULTS by typeof.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  provider: 'null',
  ollama: Object.freeze({
    host: 'http://127.0.0.1:11434',
    model: 'jarvis-worker:latest',      // main model: technical and long questions
    fastModel: '',                      // quick-chat model when auto routing is on ('' = main model)
    auto: true,                         // route per turn and decide thinking per question
    think: false,                       // thinking when auto is off
    keepAlive: '30m',                   // keep models in VRAM between questions
  }),
  startAtLogin: true,
  engines: Object.freeze({ stt: 'whisper', tts: 'piper', wake: 'whisper' }), // Windows speech is the fallback
  wakeEnabled: false,
  micDeviceId: null,
  voiceRate: 1.0,
  hotkeys: Object.freeze({ chat: 'Control+Space', voice: 'Control+Shift+Space' }),
  port: 47801,
  // knowledge & live data (spec 2026-11-10-knowledge §3): allowlisted lookups only
  online: Object.freeze({ enabled: true, weather: true, news: true, sports: true, wiki: true }),
  location: Object.freeze({ city: 'Abilene, TX', lat: 32.4487, lon: -99.7331, units: 'F' }),
  news: Object.freeze({ feeds: Object.freeze([
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://feeds.npr.org/1001/rss.xml',
    'https://feeds.arstechnica.com/arstechnica/index',
    'https://www.sciencedaily.com/rss/all.xml',
  ]) }),
  sports: Object.freeze({ follow: Object.freeze([]) }),   // [{ league: 'nfl', team: 'Cowboys' }]
});

const NESTED = ['engines', 'hotkeys', 'ollama', 'online', 'location', 'news', 'sports'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// micDeviceId defaults to null but holds a string: accept string or null.
function okValue(key, def, v) {
  if (key === 'micDeviceId') return v === null || typeof v === 'string';
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === typeof def;
}

// list values keep only well-formed items
function cleanList(key, k, list) {
  if (key === 'news' && k === 'feeds') return list.filter(u => typeof u === 'string' && u.startsWith('https://'));
  if (key === 'sports' && k === 'follow') return list.filter(x => isObj(x) && typeof x.league === 'string' && typeof x.team === 'string').map(x => ({ league: x.league, team: x.team }));
  return list;
}

function merge(raw) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = isObj(raw) ? raw[key] : undefined;
    if (NESTED.includes(key)) {
      out[key] = {};
      for (const [k, d] of Object.entries(def)) {
        const sv = isObj(v) ? v[k] : undefined;
        if (Array.isArray(d)) out[key][k] = Array.isArray(sv) ? cleanList(key, k, sv) : [...d];
        else if (typeof d === 'number') out[key][k] = typeof sv === 'number' && Number.isFinite(sv) ? sv : d;
        else out[key][k] = typeof sv === typeof d ? sv : d;
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
