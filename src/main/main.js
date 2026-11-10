// JARVIS core: Electron shell around src/core. Local only.
const path = require('node:path');
const { app, globalShortcut } = require('electron');

// Data in %APPDATA%\jarvis-core (JARVIS_DATA_DIR overrides it, for self-tests).
const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(app.getPath('appData'), 'jarvis-core');
app.setPath('userData', DATA_DIR);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const { createBus } = require('../core/bus');
const { loadConfig, saveConfig } = require('../core/config');
const { createSessionStore } = require('../core/session');
const { createRegistry } = require('../core/providers/provider');
const { NullProvider } = require('../core/providers/null-provider');
const { createToolRunner } = require('../core/tools/registry');
const { timeTool } = require('../core/tools/time');
const { createOrchestrator } = require('../core/orchestrator');
const { startBridge } = require('../core/bridge');
const { registerHotkeys } = require('./hotkeys');
const { createWindows } = require('./windows');
const { createTray } = require('./tray');
const { registerIpc } = require('./ipc');

const version = require('../../package.json').version;

const ctx = {
  dataDir: DATA_DIR,
  config: loadConfig(DATA_DIR),
  sessionId: null,
  hotkeys: { failed: [], registered: [] },
  bridge: null,
  voice: null,
  log: (...a) => console.log('[jarvis]', ...a),
};

ctx.bus = createBus({ onError: err => ctx.log('listener error:', err?.message) });
ctx.sessions = createSessionStore(DATA_DIR);
ctx.providers = createRegistry();
ctx.providers.add(NullProvider);
ctx.toolList = [timeTool];
ctx.tools = createToolRunner(ctx.toolList);
ctx.getConfig = () => ctx.config;
ctx.saveConfig = next => { saveConfig(DATA_DIR, next); ctx.config = loadConfig(DATA_DIR); return ctx.config; };
ctx.orchestrator = createOrchestrator({
  bus: ctx.bus, sessions: ctx.sessions, providers: ctx.providers, tools: ctx.tools, getConfig: ctx.getConfig,
});

function applyHotkeys() {
  const { chat, voice } = ctx.config.hotkeys;
  const map = {};
  map[chat] = () => ctx.windows.toggleChat();
  if (voice !== chat) map[voice] = () => ctx.startVoice?.();
  ctx.hotkeys = registerHotkeys(globalShortcut, map, ctx.hotkeys);
  if (ctx.hotkeys.failed.length) ctx.log('hotkeys not registered (taken?):', ctx.hotkeys.failed.join(', '));
  ctx.tray?.setFailed(ctx.hotkeys.failed);
  return ctx.hotkeys;
}
ctx.applyHotkeys = applyHotkeys;

// Voice is wired in by later modules (voice controller); until then a no-op that opens chat.
ctx.startVoice = () => { ctx.windows.showChat(); ctx.voice?.listen(); };

app.on('second-instance', () => ctx.windows?.showChat());
app.on('window-all-closed', () => { /* tray app: stay alive */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ctx.bridge?.close();
  ctx.onQuit?.forEach(fn => { try { fn(); } catch { /* quitting */ } });
});

app.whenReady().then(async () => {
  ctx.windows = createWindows({ hideOnBlur: !process.env.JARVIS_SELFTEST });
  ctx.windows.ensureChat();
  ctx.bus.on('*', ev => ctx.windows.sendAll('ai:event', ev));
  registerIpc(ctx);
  ctx.tray = createTray({
    openChat: () => ctx.windows.showChat(),
    talk: () => ctx.startVoice(),
    openSettings: () => ctx.windows.showSettings(),
    quit: () => app.quit(),
  });
  applyHotkeys();

  const ports = [0, 1, 2, 3, 4, 5].map(i => ctx.config.port + i);
  try {
    ctx.bridge = await startBridge({
      bus: ctx.bus, version, ports,
      onOpen: mode => { if (mode === 'voice') ctx.startVoice(); else ctx.windows.showChat(); },
    });
    ctx.log('bridge on 127.0.0.1:' + ctx.bridge.port);
  } catch (err) {
    ctx.log('bridge off:', err.message); // wallpaper link is optional
  }

  ctx.orchestrator.announce();
  ctx.onReady?.forEach(fn => fn());
  if (process.env.JARVIS_SELFTEST) require('./selftest').run(ctx, process.env.JARVIS_SELFTEST);
});

module.exports = { ctx };
