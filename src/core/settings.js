// Settings panel logic: validate a patch from the UI and describe what can be chosen.
const path = require('node:path');
const { feedUrl, SOURCES } = require('./net/policy');
const { LEAGUES } = require('./knowledge/sports');
const { HHMM } = require('./config');
const { cleanMonitors, patchMonitors, clampNumber } = require('./proactive/monitor-config');
const DIALECTS = require('./voice/dialect').list().map(d => d.id);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function applyPatch(current, patch = {}, { providers, engines }) {
  const config = { ...current, engines: { ...current.engines }, hotkeys: { ...current.hotkeys }, ollama: { ...current.ollama }, online: { ...current.online }, location: { ...current.location }, news: { feeds: [...current.news.feeds] }, sports: { follow: current.sports.follow.map(x => ({ ...x })) }, music: { ...current.music, aliases: (current.music?.aliases || []).map(x => ({ ...x })) }, proactive: { ...current.proactive, monitors: cleanMonitors(current.proactive?.monitors) }, browser: { ...current.browser }, user: { ...current.user }, memory: { ...current.memory }, cortex: { ...current.cortex }, speech: { ...current.speech }, library: { ...current.library } };
  const errors = [];
  if (!isObj(patch)) return { config, errors: ['bad patch'] };

  if ('provider' in patch) {
    if (typeof patch.provider === 'string' && providers.get(patch.provider)) config.provider = patch.provider;
    else errors.push(`Unknown provider "${patch.provider}"`);
  }
  if (isObj(patch.ollama)) {
    const next = { ...config.ollama };
    if ('model' in patch.ollama) {
      if (typeof patch.ollama.model === 'string' && patch.ollama.model.trim()) next.model = patch.ollama.model.trim();
      else errors.push('Empty Ollama model');
    }
    if ('host' in patch.ollama) {
      const h = typeof patch.ollama.host === 'string' ? patch.ollama.host.trim().replace(/\/+$/, '') : '';
      if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h)) next.host = h;
      else errors.push('Ollama host must be local (http://127.0.0.1:11434)');
    }
    if ('think' in patch.ollama) next.think = !!patch.ollama.think;
    if ('auto' in patch.ollama) next.auto = !!patch.ollama.auto;
    if ('fastModel' in patch.ollama) {
      if (typeof patch.ollama.fastModel === 'string') next.fastModel = patch.ollama.fastModel.trim(); // '' = use the main model
      else errors.push('Bad fast model');
    }
    config.ollama = next;
  }
  if (isObj(patch.memory)) {
    for (const key of ['autoCapture', 'usePastChats']) {
      if (!(key in patch.memory)) continue;
      if (typeof patch.memory[key] === 'boolean') config.memory[key] = patch.memory[key];
      else errors.push(`Bad memory switch: ${key}`);
    }
  }
  if (isObj(patch.engines)) {
    for (const kind of ['stt', 'tts', 'wake']) {
      if (!(kind in patch.engines)) continue;
      const id = patch.engines[kind];
      if (typeof id === 'string' && engines[kind].get(id)) config.engines[kind] = id;
      else errors.push(`Unknown ${kind} engine "${id}"`);
    }
  }
  if (isObj(patch.online)) {
    for (const key of ['enabled', ...SOURCES]) {
      if (!(key in patch.online)) continue;
      if (typeof patch.online[key] === 'boolean') config.online[key] = patch.online[key];
      else errors.push(`Bad online switch: ${key}`);
    }
  }
  if (isObj(patch.location)) {
    const next = { ...config.location, ...patch.location };
    if (typeof next.city !== 'string' || !next.city.trim() || next.city.length > 200 || typeof next.lat !== 'number' || !Number.isFinite(next.lat) || Math.abs(next.lat) > 90 || typeof next.lon !== 'number' || !Number.isFinite(next.lon) || Math.abs(next.lon) > 180 || !/^[A-Z]{2}$/.test(next.country)) errors.push('Invalid location');
    else config.location = { city: next.city.trim(), lat: next.lat, lon: next.lon, country: next.country, units: config.location.units };
    if ('units' in patch.location) {
      if (['F', 'C'].includes(patch.location.units)) config.location.units = patch.location.units;
      else errors.push('Units must be F or C');
    }
  }
  if (isObj(patch.news) && 'feeds' in patch.news) {
    const feeds = patch.news.feeds;
    if (!Array.isArray(feeds) || feeds.length > 20 || feeds.some(u => !feedUrl(u))) errors.push('News feeds must be public HTTPS URLs without credentials or ports (max 20)');
    else config.news.feeds = [...new Set(feeds.map(feedUrl))];
  }
  if (isObj(patch.sports) && 'follow' in patch.sports) {
    const follow = patch.sports.follow;
    if (!Array.isArray(follow) || follow.length > 20 || follow.some(x => !isObj(x) || !Object.hasOwn(LEAGUES, x.league) || typeof x.team !== 'string' || !x.team.trim() || x.team.length > 100)) errors.push('Followed teams need a supported league and team name (max 20)');
    else config.sports.follow = follow.map(x => ({ league: x.league, team: x.team.trim() }));
  }
  if (isObj(patch.music)) {
    const m = patch.music;
    if ('aliases' in m) {
      const ok = Array.isArray(m.aliases) && m.aliases.length <= 50 && m.aliases.every(x => isObj(x) && typeof x.alias === 'string' && x.alias.trim() && x.alias.length <= 50 && typeof x.playlistId === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(x.playlistId));
      if (ok) config.music.aliases = m.aliases.map(x => ({ alias: x.alias.trim(), playlistId: x.playlistId }));
      else errors.push('Playlist shortcuts need a name and a playlist id (max 50)');
    }
    if ('logPlays' in m) config.music.logPlays = !!m.logPlays;
    for (const [key, min, max] of [['libraryTtlSec', 10, 3600], ['playlistTtlSec', 5, 3600], ['digestSize', 0, 100], ['maxBulk', 1, 50]]) {
      if (!(key in m)) continue;
      const n = Number(m[key]);
      if (Number.isFinite(n)) config.music[key] = Math.round(Math.max(min, Math.min(max, n)));
      else errors.push(`Bad music setting: ${key}`);
    }
  }
  if (isObj(patch.browser) && 'enabled' in patch.browser) config.browser.enabled = !!patch.browser.enabled;
  if (isObj(patch.proactive)) {
    const p = patch.proactive;
    for (const k of ['enabled', 'dnd', 'chime']) if (k in p) config.proactive[k] = !!p[k];
    for (const k of ['quietStart', 'quietEnd']) {
      if (!(k in p)) continue;
      if (typeof p[k] === 'string' && HHMM.test(p[k])) config.proactive[k] = p[k];
      else errors.push('Quiet hours must be times like 22:00');
    }
    if ('minGapSec' in p) {
      const n = Number(p.minGapSec);
      if (Number.isFinite(n)) config.proactive.minGapSec = Math.round(Math.max(3, Math.min(120, n)));
      else errors.push('Bad gap between spoken alerts');
    }
    for (const [k, min, max, label] of [['cooldownMin', 1, 240, 'alert cooldown'], ['maxPerHour', 1, 60, 'alerts per hour']]) {
      if (!(k in p)) continue;
      const n = Number(p[k]);
      if (Number.isFinite(n)) config.proactive[k] = clampNumber(n, min, max);
      else errors.push(`Bad ${label}`);
    }
    if ('monitors' in p) {
      const r = patchMonitors(config.proactive.monitors, p.monitors);
      config.proactive.monitors = r.monitors;
      errors.push(...r.errors);
    }
  }
  if (isObj(patch.user)) {
    for (const [k, max] of [['name', 60], ['about', 500]]) {
      if (!(k in patch.user)) continue;
      const v = patch.user[k];
      if (typeof v === 'string' && v.length <= max) config.user[k] = v.replace(/\s+/g, ' ').trim();
      else errors.push(`Your ${k} must be text up to ${max} characters`);
    }
  }
  if ('wakeEnabled' in patch) config.wakeEnabled = !!patch.wakeEnabled;
  if ('speakerGate' in patch) config.speakerGate = !!patch.speakerGate;
  if ('sttGpu' in patch) config.sttGpu = !!patch.sttGpu;
  if ('vad' in patch) {
    if (patch.vad === 'silero' || patch.vad === 'energy') config.vad = patch.vad;
    else errors.push('VAD must be silero or energy');
  }
  if ('startAtLogin' in patch) config.startAtLogin = !!patch.startAtLogin;
  if ('micDeviceId' in patch) {
    if (patch.micDeviceId === null || typeof patch.micDeviceId === 'string') config.micDeviceId = patch.micDeviceId || null;
    else errors.push('Bad mic device');
  }
  if ('voiceRate' in patch) {
    const r = Number(patch.voiceRate);
    if (Number.isFinite(r)) config.voiceRate = Math.round(Math.max(0.5, Math.min(2, r)) * 100) / 100;
    else errors.push('Bad voice rate');
  }
  if (isObj(patch.speech)) {
    const sp = patch.speech;
    if ('dialect' in sp) { if (DIALECTS.includes(sp.dialect)) config.speech.dialect = sp.dialect; else errors.push(`Unknown dialect: ${String(sp.dialect).slice(0, 30)}`); }
    for (const k of ['contractions', 'pauses']) if (k in sp) { if (typeof sp[k] === 'boolean') config.speech[k] = sp[k]; else errors.push(`Bad speech switch: ${k}`); }
    if ('dateOrder' in sp) { if (sp.dateOrder === 'mdy' || sp.dateOrder === 'dmy') config.speech.dateOrder = sp.dateOrder; else errors.push('Date order must be mdy or dmy'); }
  }
  if (isObj(patch.library) && 'dir' in patch.library) {
    const dir = typeof patch.library.dir === 'string' ? patch.library.dir.trim() : '';
    if (dir && dir.length <= 260 && path.isAbsolute(dir)) config.library.dir = dir;
    else errors.push('Library folder must be an absolute path (like C:\\JarvisData\\library)');
  }
  if (isObj(patch.hotkeys)) {
    const next = { ...config.hotkeys };
    for (const k of ['chat', 'voice']) {
      if (!(k in patch.hotkeys)) continue;
      const v = patch.hotkeys[k];
      if (typeof v === 'string' && v.trim()) next[k] = v.trim();
      else errors.push(`Empty ${k} hotkey`);
    }
    if (next.chat === next.voice) errors.push('Chat and voice hotkeys must differ');
    else config.hotkeys = next;
  }
  return { config, errors };
}

async function statusSafe(item, timeoutMs) {
  let timer;
  try {
    const st = await Promise.race([
      Promise.resolve().then(() => item.status()),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('No answer')), timeoutMs); }),
    ]);
    return { ready: !!st?.ready, detail: String(st?.detail ?? '') };
  } catch (err) {
    return { ready: false, detail: err?.message || 'status failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function describe({ config, providers, engines, hotkeyFailures = [], statusTimeoutMs = 4000, library = null }) {
  const list = async reg => Promise.all(reg.list().map(async ({ id, label }) => ({ id, label, ...(await statusSafe(reg.get(id), statusTimeoutMs)) })));
  const [p, stt, tts, wake] = await Promise.all([list(providers), list(engines.stt), list(engines.tts), list(engines.wake)]);
  let models = [];
  const ollama = providers.get('ollama');
  if (ollama?.listModels) {
    let timer;
    try { models = await Promise.race([
      ollama.listModels(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('No answer')), statusTimeoutMs); }),
    ]); } catch { models = []; } finally { clearTimeout(timer); }
  }
  return { config, providers: p, engines: { stt, tts, wake }, models, hotkeyFailures: [...hotkeyFailures], library, dialects: require('./voice/dialect').list() };
}

module.exports = { applyPatch, describe, statusSafe };
