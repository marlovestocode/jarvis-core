// JARVIS core: Electron shell around src/core. Local only.
const path = require('node:path');
const { app, globalShortcut, session } = require('electron');

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
const { createSysmonTool } = require('../core/tools/sysmon');
const { createMediaTool } = require('../core/tools/media');
const { createOrchestrator } = require('../core/orchestrator');
const { startBridge } = require('../core/bridge');
const { createEngineRegistries } = require('../core/voice/engines');
const { createSpeechHost, windowsTts, windowsStt, windowsWake } = require('../core/voice/windows-speech');
const { createVoiceController } = require('../core/voice/controller');
const { registerHotkeys } = require('./hotkeys');
const { createMic } = require('./mic');
const { guardWebContents } = require('./guard');
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
ctx.toolList = [timeTool, createSysmonTool(), createMediaTool()];
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

// ---- voice: Windows built-in speech (System.Speech) via one PowerShell host ----
ctx.speechHost = createSpeechHost({ log: ctx.log });
ctx.engines = createEngineRegistries();
ctx.engines.stt.add(windowsStt(ctx.speechHost));
ctx.engines.tts.add(windowsTts(ctx.speechHost));
ctx.engines.wake.add(windowsWake(ctx.speechHost));
const engine = kind => ctx.engines[kind].get(ctx.config.engines[kind]) || ctx.engines[kind].get('none');
ctx.voice = createVoiceController({
  bus: ctx.bus, orchestrator: ctx.orchestrator,
  engines: { stt: () => engine('stt'), tts: () => engine('tts'), wake: () => engine('wake') },
  getConfig: ctx.getConfig, getSessionId: () => ctx.sessionId, setSessionId: id => { ctx.sessionId = id; },
});
ctx.micOk = true;
ctx.startVoice = () => {
  ctx.windows.showChat();
  if (!ctx.micOk) { ctx.mic?.start(); } // retry: the mic may be back
  ctx.voice.listen();
};
ctx.bus.on('log', ev => ctx.log(ev.text));
// mic open only while voice is active
ctx.bus.on('state', () => {
  if (!ctx.mic) return;
  if (ctx.voice.active) ctx.mic.start(); else ctx.mic.stop();
});
ctx.onQuit = [() => ctx.speechHost.close(), () => ctx.mic?.destroy()];

app.on('web-contents-created', (_e, wc) => guardWebContents(wc));
app.on('second-instance', () => ctx.windows?.showChat());
app.on('window-all-closed', () => { /* tray app: stay alive */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ctx.bridge?.close();
  ctx.onQuit?.forEach(fn => { try { fn(); } catch { /* quitting */ } });
});

app.whenReady().then(async () => {
  // only our own pages may use the mic; nothing else gets any permission
  const own = wc => { try { return new URL(wc.getURL()).protocol === 'file:'; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && own(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && !!wc && own(wc));

  ctx.windows = createWindows({ hideOnBlur: !process.env.JARVIS_SELFTEST });
  ctx.mic = createMic({
    getDeviceId: () => ctx.config.micDeviceId,
    onFrame: (pcm, rate) => ctx.voice.feed(pcm, rate),
    onStatus: s => {
      ctx.bus.emit('mic', { ok: s.ok, reason: s.reason });
      if (s.ok) { ctx.micOk = true; return; }
      ctx.micOk = false;
      ctx.voice.cancel();
      ctx.bus.emit('state', { state: 'idle', detail: `Mic unavailable: ${s.reason}` });
    },
    log: ctx.log,
  });
  ctx.mic.ensure(); // load the hidden mic page now so the first capture starts fast
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
  ctx.voice.applyWake();
  ctx.onReady?.forEach(fn => fn());
  if (process.env.JARVIS_SELFTEST) require('./selftest').run(ctx, process.env.JARVIS_SELFTEST);
});

module.exports = { ctx };
