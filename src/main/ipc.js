// core ↔ renderer. Every handler is thin; the logic lives in src/core.
const { ipcMain, clipboard, globalShortcut } = require('electron');
const { applyPatch, describe } = require('../core/settings');

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
  h('ai:new', () => { const s = sessions.create(); sessions.save(s); ctx.sessionId = s.id; return s; });
  h('ai:open', id => { const s = sessions.load(id); if (s) ctx.sessionId = s.id; return s || currentSession(); });
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
    if (orchestrator.busy) { orchestrator.stop(); return 'stopped'; }
    if (ctx.voice && (ctx.voice.speaking || ctx.voice.active)) { ctx.voice.cancel(); return 'cancelled'; }
    windows.hideChat();
    return 'hidden';
  });
  h('ai:copy', text => { clipboard.writeText(String(text)); });
  h('ai:settings', () => { windows.showSettings(); });
  h('ai:voice', () => ctx.startVoice?.());
  h('ai:status', () => orchestrator.announce());

  // ---- settings window ----
  const describeNow = () => describe({ config: ctx.config, providers: ctx.providers, engines: ctx.engines, hotkeyFailures: ctx.hotkeys.failed });
  h('settings:get', () => describeNow());
  h('settings:set', async patch => {
    const { config, errors } = applyPatch(ctx.config, patch, { providers: ctx.providers, engines: ctx.engines });
    ctx.saveConfig(config);
    ctx.applyHotkeys();
    ctx.voice?.applyWake();
    orchestrator.announce();
    return { ...(await describeNow()), errors };
  });
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
  h('settings:close', () => { if (windows.settings && !windows.settings.isDestroyed()) windows.settings.close(); });
}

module.exports = { registerIpc };
