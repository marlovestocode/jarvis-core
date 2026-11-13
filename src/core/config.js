// Settings in <dir>/config.json, merged per key against DEFAULTS by typeof.
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_MONITORS, cleanMonitors, clampNumber } = require('./proactive/monitor-config');

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
  wakeInterrupt: 'now',                // "Jarvis" while JARVIS speaks: 'now' cuts the speech | 'sentence' (old) lets it finish
  sttModel: 'ggml-small.en-q5_1.bin', // Whisper model file under engines/whisper (bare *.bin name); small.en on the GPU, base.en when sttGpu is off
  sttGpu: true,                        // Whisper on the GPU (CUDA); falls back to the CPU if it cannot start
  sttPrompt: 'v0',                     // Whisper vocabulary prompt: v0 (original) | v1 (+ command words) | none
  vad: 'silero',                       // 'silero' (model, default since Gate 1) | 'energy' (old); silero falls back to energy if it cannot load
  endSilenceMs: 700,                   // quiet that ends a spoken turn; 550 passes the corpus pause set with Silero (Phase 4)
  continuationGuard: false,            // a turn ending on "and"/"the"/... listens 1.5 s more before answering (Phase 4)
  speakerGate: true,                   // once a voice is enrolled, only that voice wakes JARVIS by "Jarvis" (the hotkey always works)
  speakerThreshold: 0.45,              // cosine match needed (same voice ~0.8-0.9, another voice ~0.1-0.3)
  micDeviceId: null,
  voiceRate: 1.0,
  hotkeys: Object.freeze({ chat: 'Control+Space', voice: 'Control+Shift+Space' }),
  constrainTools: true,                // repair a tool call that names no tool or has bad arguments with a schema-constrained decode (tools/constrain.js)
  port: 47801,
  // knowledge & live data (spec 2026-11-10-knowledge §3): allowlisted lookups only
  online: Object.freeze({ enabled: true, weather: true, news: true, sports: true, wiki: true, web: true, lyrics: true }),
  // who the user is: JARVIS addresses them by name and treats this as known (settings or "call me ...")
  user: Object.freeze({ name: '', about: '' }),
  location: Object.freeze({ city: 'Abilene, TX', lat: 32.4487, lon: -99.7331, country: 'US', units: 'F' }),
  news: Object.freeze({ feeds: Object.freeze([
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://feeds.npr.org/1001/rss.xml',
    'https://feeds.arstechnica.com/arstechnica/index',
    'https://www.sciencedaily.com/rss/all.xml',
  ]) }),
  sports: Object.freeze({ follow: Object.freeze([]) }),   // [{ league: 'nfl', team: 'Cowboys' }]
  // the user's YouTube Music playlists (plan 2026-11-10-ytm-playlists): all data is read live; these are only preferences
  music: Object.freeze({
    aliases: Object.freeze([]),         // [{ alias: 'gym', playlistId: 'PL...' }] spoken shortcuts
    libraryTtlSec: 300,                 // how long the playlist list stays fresh
    playlistTtlSec: 120,                // how long one playlist's songs stay fresh
    digestSize: 30,                     // playlists named to the model in its prompt
    maxBulk: 25,                        // most songs added to a playlist in one go
    logPlays: true,                     // keep a local log of what you listen to (music_stats); off stops logging
  }),
  // PC control: extra apps JARVIS may open, { "spoken name": "C:\path\app.exe" or a Start menu AppID }
  pc: Object.freeze({ apps: Object.freeze({}) }),
  // browser skills (tabs, page text, history...) through the Chrome extension: off until the user turns it on in settings
  browser: Object.freeze({ enabled: false }),
  // JARVIS speaking unasked (timers): quiet hours and Do-not-disturb give a notification only
  proactive: Object.freeze({ enabled: true, dnd: false, quietStart: '22:00', quietEnd: '07:00', minGapSec: 10, chime: true, monitors: DEFAULT_MONITORS, cooldownMin: 15, maxPerHour: 6 }),
  // long-term memory (cortex wave 1): summarize finished chats into the review queue; recall past chats in answers
  memory: Object.freeze({ autoCapture: true, usePastChats: true }),
  // the cortex's embedding model in the local Ollama (only pulled after the user clicks Install and confirms)
  // wallpaperLabels: the wallpaper may ask for a few words per memory node it shows (strict local route, see core/bridge.js)
  cortex: Object.freeze({ embedModel: 'nomic-embed-text', wallpaperLabels: true }),
  // how he talks (core/voice/dialect.js): the dialect names his word choice and register, the rest tunes the spoken text
  speech: Object.freeze({ dialect: 'british-formal', contractions: true, pauses: true, dateOrder: 'mdy' }),
});

const VADS = ['silero', 'energy'];
const NESTED = ['user', 'engines', 'hotkeys', 'ollama', 'online', 'location', 'news', 'sports', 'music', 'proactive', 'pc', 'browser', 'memory', 'cortex', 'speech'];
const MODEL_NAME = /^[\w.:-]{1,64}$/;   // an Ollama model tag, e.g. nomic-embed-text:latest
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;   // "22:00"
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// micDeviceId defaults to null but holds a string: accept string or null.
function okValue(key, def, v) {
  if (key === 'micDeviceId') return v === null || typeof v === 'string';
  if (key === 'vad') return VADS.includes(v);
  if (key === 'wakeInterrupt') return v === 'now' || v === 'sentence';
  if (key === 'speakerThreshold') return typeof v === 'number' && v >= 0.2 && v <= 0.9;
  if (key === 'sttPrompt') return ['v0', 'v1', 'none'].includes(v);
  if (key === 'sttModel') return typeof v === 'string' && /^[\w-][\w.-]*\.bin$/.test(v);
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === typeof def;
}

// list values keep only well-formed items
function cleanList(key, k, list) {
  if (key === 'news' && k === 'feeds') return [...new Set(list.map(require('./net/policy').feedUrl).filter(Boolean))].slice(0, 20);
  if (key === 'sports' && k === 'follow') return list.filter(x => isObj(x) && typeof x.league === 'string' && typeof x.team === 'string').map(x => ({ league: x.league, team: x.team }));
  if (key === 'music' && k === 'aliases') return list.filter(x => isObj(x) && typeof x.alias === 'string' && x.alias.trim() && typeof x.playlistId === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(x.playlistId)).map(x => ({ alias: x.alias.trim().slice(0, 50), playlistId: x.playlistId })).slice(0, 50);
  return list;
}

// pc.apps: only well-formed { name: target } pairs (see pc/apps.js validAppTarget)
function cleanApps(v) {
  if (!isObj(v)) return {};
  const { validAppTarget } = require('./pc/apps');
  return Object.fromEntries(Object.entries(v).filter(([n, t]) => n.trim() && n.length <= 60 && validAppTarget(t)).slice(0, 50));
}

function merge(raw) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = isObj(raw) ? raw[key] : undefined;
    if (NESTED.includes(key)) {
      out[key] = {};
      for (const [k, d] of Object.entries(def)) {
        const sv = isObj(v) ? v[k] : undefined;
        if (key === 'pc' && k === 'apps') { out[key][k] = cleanApps(sv); continue; }
        if (Array.isArray(d)) out[key][k] = Array.isArray(sv) ? cleanList(key, k, sv) : [...d];
        else if (typeof d === 'number') out[key][k] = typeof sv === 'number' && Number.isFinite(sv) ? sv : d;
        else out[key][k] = typeof sv === typeof d ? sv : d;
      }
      if (key === 'proactive') {
        for (const k of ['quietStart', 'quietEnd']) if (!HHMM.test(out[key][k])) out[key][k] = def[k];
        out[key].minGapSec = Math.round(Math.max(3, Math.min(120, out[key].minGapSec)));
        out[key].monitors = cleanMonitors(isObj(v) ? v.monitors : undefined);
        out[key].cooldownMin = clampNumber(out[key].cooldownMin, 1, 240);
        out[key].maxPerHour = clampNumber(out[key].maxPerHour, 1, 60);
      }
      if (key === 'cortex' && !MODEL_NAME.test(out[key].embedModel)) out[key].embedModel = def.embedModel;
    } else {
      out[key] = v !== undefined && okValue(key, def, v) ? v : def;
      if (key === 'endSilenceMs') out[key] = Math.round(Math.max(300, Math.min(1500, out[key])));
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

// config.json against what is in effect (for self_config and the self-check). Reads only.
//   ignored: keys in the file that are unknown, or whose value was refused or adjusted by merge()
//   changed: settings in effect that differ from DEFAULTS
//   broken:  an earlier unreadable config.json was set aside as config.broken.json
function inspectConfig(dir) {
  const file = path.join(dir, 'config.json');
  const out = { file, exists: false, error: '', broken: fs.existsSync(path.join(dir, 'config.broken.json')), ignored: [], changed: [] };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.exists = true;
    if (!isObj(raw)) { out.error = 'config.json is not an object'; raw = {}; }
  } catch (err) {
    if (err.code !== 'ENOENT') { out.exists = true; out.error = err.message; }
  }
  const config = merge(raw);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [key, v] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) out.ignored.push(key);
    else if (NESTED.includes(key) && isObj(v)) {
      for (const [k, sv] of Object.entries(v)) if (!Object.hasOwn(DEFAULTS[key], k) || !same(sv, config[key][k])) out.ignored.push(`${key}.${k}`);
    } else if (!same(v, config[key])) out.ignored.push(key);
  }
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (NESTED.includes(key)) { for (const k of Object.keys(def)) if (!same(config[key][k], def[k])) out.changed.push(`${key}.${k}`); }
    else if (!same(config[key], def)) out.changed.push(key);
  }
  return { ...out, config };
}

module.exports = { DEFAULTS, HHMM, MODEL_NAME, loadConfig, saveConfig, inspectConfig };
