// core ↔ renderer. Every handler is thin; the logic lives in src/core.
const { ipcMain, clipboard, globalShortcut } = require('electron');
const { applyPatch, describe } = require('../core/settings');
const { searchPlaces, toPlace } = require('../core/knowledge/location');
const { createMemoryHandlers } = require('./memory-ipc');

function registerIpc(ctx) {
  const { orchestrator, sessions, windows } = ctx;

  const currentSession = () => {
    let s = ctx.sessionId ? sessions.load(ctx.sessionId) : null;
    if (!s) {
      const recent = sessions.list()[0];
      s = recent ? sessions.load(recent.id) : null;
    }
    if (!s) { s = sessions.create(); sessions.save(s); }
    ctx.sessionId = s.id;
    return s;
  };
  ctx.currentSession = currentSession;

  async function send(text) {
    currentSession();
    try {
      const res = await orchestrator.send(ctx.sessionId, text, { source: 'text' });
      ctx.sessionId = res.sessionId;
      return res;
    } catch (err) {
      return { error: err.message === 'BUSY' ? 'BUSY' : String(err.message || err), reply: '', stopped: false };
    }
  }

  const h = (ch, fn) => { ipcMain.removeHandler(ch); ipcMain.handle(ch, (_e, ...a) => fn(...a)); };

  h('ai:send', text => send(String(text || '').slice(0, 200000)));
  h('ai:stop', () => { orchestrator.stop(); ctx.voice?.cancel(); });
  // leaving a chat lets memory summarize it (when it is ready and JARVIS is idle)
  const switched = prev => { if (prev && prev !== ctx.sessionId) ctx.onSessionSwitch?.(prev); };
  h('ai:new', () => { const prev = ctx.sessionId; const s = sessions.create(); sessions.save(s); ctx.sessionId = s.id; switched(prev); return s; });
  h('ai:open', id => { const prev = ctx.sessionId; const s = sessions.load(id); if (s) ctx.sessionId = s.id; switched(prev); return s || currentSession(); });
  h('ai:current', () => currentSession());
  h('ai:clear', () => {
    if (orchestrator.busy) return currentSession();
    const s = currentSession(); s.messages = []; sessions.save(s); return s;
  });
  h('ai:retry', async () => {
    if (orchestrator.busy) return { error: 'BUSY' };
    const s = currentSession();
    while (s.messages.length && s.messages.at(-1).role !== 'user') s.messages.pop();
    const last = s.messages.pop();
    if (!last) return { error: 'Nothing to retry' };
    sessions.save(s);
    return send(last.content);
  });
  h('ai:list', () => sessions.list());
  h('ai:hide', () => windows.hideChat());
  // Esc: stop a reply, else cut speech, else hide.
  h('ai:escape', () => {
    if (orchestrator.busy) { orchestrator.stop(); ctx.voice?.cancel(); return 'stopped'; }
    if (ctx.voice && (ctx.voice.speaking || ctx.voice.active)) { ctx.voice.cancel(); return 'cancelled'; }
    windows.hideChat();
    return 'hidden';
  });
  h('ai:copy', text => { clipboard.writeText(String(text)); });
  h('ai:settings', () => { windows.showSettings(); });
  h('ai:voice', () => ctx.startVoice?.());
  h('ai:status', () => orchestrator.announce());

  // ---- settings window ----
  const describeNow = async () => describe({ config: ctx.config, providers: ctx.providers, engines: ctx.engines, hotkeyFailures: ctx.hotkeys.failed, library: await ctx.kiwix.info() });
  h('settings:get', () => describeNow());
  h('settings:places', async query => {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) return { places: [], error: 'Enter a city (max 200 characters)' };
    try { return { places: (await searchPlaces(ctx.fetcher, query)).slice(0, 10).map(toPlace) }; }
    catch (err) { return { places: [], error: err.message }; }
  });
  h('settings:set', async patch => {
    const { config, errors } = applyPatch(ctx.config, patch, { providers: ctx.providers, engines: ctx.engines });
    const modelChanged = JSON.stringify(config.ollama) !== JSON.stringify(ctx.config.ollama) || config.provider !== ctx.config.provider;
    ctx.saveConfig(config);
    ctx.applyHotkeys();
    if ('startAtLogin' in patch) ctx.applyLogin?.();
    if (modelChanged) ctx.providers.get(ctx.config.provider)?.warm?.().catch?.(() => {}); // load the new model now, not on the first question
    ctx.voice?.applyWake();
    ctx.updateMic?.();
    orchestrator.announce();
    return { ...(await describeNow()), errors };
  });
  // your voice: enrol (about 12 s of speech), forget, status. Only numbers are stored.
  const voiceStatus = () => ({ available: ctx.speaker.available(), enrolled: ctx.speaker.enrolled(), count: ctx.speaker.count(), enrolling: !!ctx.enrollBuf });
  h('speaker:status', () => voiceStatus());
  h('speaker:enroll', async () => { const r = await ctx.enrollVoice(); return { ...r, ...voiceStatus() }; });
  h('speaker:clear', () => { ctx.speaker.clear(); return voiceStatus(); });
  // while a hotkey field is capturing, release global shortcuts so the keypress reaches the field
  let capturing = false;
  h('settings:capture', on => {
    if (on && !capturing) {
      capturing = true;
      globalShortcut.unregisterAll();
      ctx.hotkeys = { failed: ctx.hotkeys.failed, registered: [] };
      windows.settings?.once('closed', () => { if (capturing) { capturing = false; ctx.applyHotkeys(); } });
    } else if (!on && capturing) {
      capturing = false;
      ctx.applyHotkeys();
    }
  });
  // Settings → Memory (W1 §6): every verb validates its payload in memory-ipc.js
  if (ctx.memory && ctx.cortex) for (const [ch, fn] of Object.entries(createMemoryHandlers(ctx))) h(ch, fn);
  h('settings:close', () => { if (windows.settings && !windows.settings.isDestroyed()) windows.settings.close(); });
}

module.exports = { registerIpc };
