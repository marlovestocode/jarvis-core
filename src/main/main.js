// JARVIS core: Electron shell around src/core. Local only.
const path = require('node:path');
const fs = require('node:fs');
const { app, globalShortcut, session } = require('electron');

// Data in %APPDATA%\jarvis-core (JARVIS_DATA_DIR overrides it, for self-tests).
const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(app.getPath('appData'), 'jarvis-core');
app.setPath('userData', DATA_DIR);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Own identity (startup entry, notifications) instead of the generic "electron.app.Electron".
app.setAppUserModelId('jarvis.core');

// The chat is light 2D UI: software rendering skips the GPU process (~100 MB) and keeps
// the GPU free for the model. JARVIS_GPU=1 turns hardware acceleration back on.
if (process.env.JARVIS_GPU !== '1') app.disableHardwareAcceleration();
const HIDDEN = process.argv.includes('--hidden');          // started by Windows at login: tray only
const DEV_RUN = !!(process.env.JARVIS_DATA_DIR || process.env.JARVIS_SELFTEST);

const { createBus } = require('../core/bus');
const { loadConfig, saveConfig } = require('../core/config');
const { createSessionStore } = require('../core/session');
const { createRegistry } = require('../core/providers/provider');
const { NullProvider } = require('../core/providers/null-provider');
const { createOllamaProvider } = require('../core/providers/ollama');
const { createToolRunner } = require('../core/tools/registry');
const brain = require('../core/brain');
const { createHardwareProbe } = require('../core/brain/hardware');
const { runBoot } = require('../core/boot');
const { createOrchestrator } = require('../core/orchestrator');
const { startBridge } = require('../core/bridge');
const { createEngineRegistries } = require('../core/voice/engines');
const { createSpeechHost, windowsTts, windowsStt, windowsWake } = require('../core/voice/windows-speech');
const { createVoiceController } = require('../core/voice/controller');
const { createWhisperStt } = require('../core/voice/whisper');
const { createPiperTts } = require('../core/voice/piper');
const os = require('node:os');
const { registerHotkeys } = require('./hotkeys');
const { createMic } = require('./mic');
const { guardWebContents } = require('./guard');
const { createStartup } = require('./startup');
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
  log: (...a) => {
    const line = `${new Date().toISOString()}  ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
    console.log('[jarvis]', ...a);
    // started by Task Scheduler there is no console: keep a small log next to the config
    try {
      const file = path.join(DATA_DIR, 'jarvis.log');
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old');
      fs.appendFileSync(file, line + '\n');
    } catch { /* logging must never break the app */ }
  },
};

ctx.bus = createBus({ onError: err => ctx.log('listener error:', err?.message) });
ctx.sessions = createSessionStore(DATA_DIR);
ctx.providers = createRegistry();
ctx.providers.add(NullProvider);
ctx.providers.add(createOllamaProvider({ getConfig: () => ctx.config }));
ctx.hardware = createHardwareProbe();
ctx.getConfig = () => ctx.config;
ctx.saveConfig = next => { saveConfig(DATA_DIR, next); ctx.config = loadConfig(DATA_DIR); return ctx.config; };

// What jarvis_status reports: this PC plus the live state of every JARVIS part.
async function jarvisStatus() {
  const c = ctx.config;
  const p = ctx.providers.get(c.provider) || ctx.providers.get('null');
  let model = p.label;
  if (c.provider === 'ollama') model = `${c.ollama.model}${c.ollama.auto ? ` (quick chat: ${c.ollama.fastModel})` : ''} via Ollama`;
  let sysmon = 'not running';
  try { sysmon = (await fetch('http://127.0.0.1:47800/health', { signal: AbortSignal.timeout(800) })).ok ? 'running' : 'not running'; } catch { /* down */ }
  return {
    ...(await ctx.hardware.get()),
    model,
    sysmon,
    wallpaper: ctx.bridge ? (ctx.bridge.clients() ? 'linked to the core' : 'not connected') : 'bridge off',
    voice: `speech-to-text ${c.engines.stt}, text-to-speech ${c.engines.tts}, wake word ${c.wakeEnabled ? 'on' : 'off'}`,
    hotkeys: ctx.hotkeys.failed.length ? `taken: ${ctx.hotkeys.failed.join(', ')}` : `chat ${c.hotkeys.chat}, voice ${c.hotkeys.voice}`,
  };
}
ctx.toolList = brain.defaultTools({ getStatus: jarvisStatus });
ctx.tools = createToolRunner(ctx.toolList);
ctx.orchestrator = createOrchestrator({
  bus: ctx.bus, sessions: ctx.sessions, providers: ctx.providers, tools: ctx.tools, getConfig: ctx.getConfig,
  systemPrompt: brain.systemPrompt, route: brain.route, promptInfo: () => ({ hardware: ctx.hardware.cached() || undefined }),
  timeoutMs: 120000, // a cold model load plus thinking can be slow on the first turn
});

ctx.applyLogin = () => {
  if (DEV_RUN) return; // tests and self-checks never touch Windows startup
  try {
    const r = createStartup({ setLoginItem: o => app.setLoginItemSettings(o), execPath: process.execPath, appPath: path.resolve(app.getAppPath()), packaged: app.isPackaged })
      .apply(ctx.config.startAtLogin);
    ctx.log(`start with Windows: ${r.enabled ? 'on' : 'off'} via ${r.via}${r.note ? ' (' + r.note + ')' : ''}`);
  } catch (err) { ctx.log('startup setting failed:', err.message); }
};

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
// Local neural engines (Whisper, Piper) live in <app>/engines. Not in %LOCALAPPDATA%: writes there from a
// packaged app (e.g. a terminal inside the Claude app) are redirected into that app's private store and the
// real desktop never sees them. Windows speech is the fallback.
const ENGINES = process.env.JARVIS_ENGINES || [path.join(__dirname, '..', '..', 'engines'), path.join(app.getPath('home'), 'AppData', 'Local', 'jarvis-core', 'engines')]
  .find(d => fs.existsSync(path.join(d, 'whisper'))) || path.join(__dirname, '..', '..', 'engines');
ctx.whisper = createWhisperStt({
  exe: path.join(ENGINES, 'whisper', 'bin', 'Release', 'whisper-server.exe'), model: path.join(ENGINES, 'whisper', 'ggml-base.en.bin'),
  prompt: 'JARVIS, Ollama, sysmon, Wallpaper Engine, Ryzen, RTX 3050, GPU, CPU, VRAM, Spotify, Discord, Steam.', log: ctx.log,
});
ctx.piper = createPiperTts({
  exe: path.join(ENGINES, 'piper', 'bin', 'piper', 'piper.exe'), model: path.join(ENGINES, 'piper', 'en_GB-alan-medium.onnx'),
  outDir: path.join(os.tmpdir(), 'jarvis-tts'), play: (pcm, rate, o) => ctx.mic.play(pcm, rate, o), log: ctx.log,
});
ctx.engines.stt.add(ctx.whisper);
ctx.engines.tts.add(ctx.piper);
const engine = kind => {
  const e = ctx.engines[kind].get(ctx.config.engines[kind]);
  if (e && (!e.available || e.available())) return e;
  return ctx.engines[kind].get('windows') || ctx.engines[kind].get('none');
};
ctx.voice = createVoiceController({
  bus: ctx.bus, orchestrator: ctx.orchestrator,
  engines: { stt: () => engine('stt'), tts: () => engine('tts'), wake: () => engine('wake') },
  getConfig: ctx.getConfig, getSessionId: () => ctx.sessionId, setSessionId: id => { ctx.sessionId = id; },
  vadOptions: { silenceMs: 700 }, // Whisper is fast enough to end a phrase sooner
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
ctx.onQuit = [() => ctx.speechHost.close(), () => ctx.mic?.destroy(), () => ctx.whisper.close(), () => ctx.piper.close()];

app.on('web-contents-created', (_e, wc) => guardWebContents(wc));
app.on('second-instance', () => ctx.windows?.showChat());
app.on('window-all-closed', () => { /* tray app: stay alive */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ctx.bridge?.close();
  ctx.onQuit?.forEach(fn => { try { fn(); } catch { /* quitting */ } });
});

app.whenReady().then(async () => {
  // the wallpaper link starts first; windows and tray are built while it binds
  const ports = [0, 1, 2, 3, 4, 5].map(i => ctx.config.port + i);
  const bridgeStarting = startBridge({
    bus: ctx.bus, version, ports,
    onOpen: mode => { if (mode === 'voice') ctx.startVoice(); else ctx.windows?.showChat(); },
  });
  bridgeStarting.catch(() => {});

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
  // the hidden mic page loads on first voice use, not at startup
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

  try {
    ctx.bridge = await bridgeStarting;
    ctx.log('bridge on 127.0.0.1:' + ctx.bridge.port);
  } catch (err) {
    ctx.log('bridge off:', err.message); // wallpaper link is optional
  }
  setTimeout(() => ctx.applyLogin(), 4000); // schtasks calls are slow; never on the startup path
  if (!HIDDEN && !DEV_RUN) ctx.windows.showChat(); // opened by hand: show the boot in the chat
  ctx.onReady?.forEach(fn => fn());
  if (process.env.JARVIS_SELFTEST) require('./selftest').run(ctx, process.env.JARVIS_SELFTEST);

  // Boot: each stage reports what really happened (chat + wallpaper draw it).
  ctx.booted = runBoot(ctx.bus, [
    { stage: 'core', run: async () => `v${version}` },
    { stage: 'bridge', run: async () => (ctx.bridge ? `127.0.0.1:${ctx.bridge.port}` : { ok: false, detail: 'off' }) },
    { stage: 'hardware', run: async () => { const h = await ctx.hardware.get(); return h.gpu || h.cpu || 'unknown'; } },
    { stage: 'model', run: async () => {
      const st = await ctx.orchestrator.announce();
      const p = ctx.providers.get(ctx.config.provider);
      if (!st.ready) return { ok: false, detail: st.detail || 'no model' };
      if (p?.warm) {
        const w = await p.warm();
        if (w.error) return { ok: false, detail: w.error };
        return w.loaded.join(' + ') || st.detail;
      }
      return st.detail;
    } },
    { stage: 'sysmon', run: async () => {
      const r = await fetch('http://127.0.0.1:47800/health', { signal: AbortSignal.timeout(1000) }).catch(() => null);
      return r?.ok ? 'linked' : { ok: false, detail: 'not running' };
    } },
    { stage: 'voice', run: async () => {
      ctx.voice.applyWake();
      const stt = engine('stt'), tts = engine('tts');
      ctx.log(`voice engines: configured ${ctx.config.engines.stt}/${ctx.config.engines.tts}, using ${stt.id}/${tts.id} (engines in ${ENGINES})`);
      tts.warm?.(ctx.config.voiceRate);
      if (stt.warm) await stt.warm();
      return `${stt.label} + ${tts.label}${ctx.config.wakeEnabled ? ' + wake word' : ''}`;
    } },
  ]).then(r => { ctx.log(`boot ${r.ok ? 'ok' : 'partial'} in ${r.ms} ms`); return r; });
  ctx.bus.on('boot', e => { if (e.stage !== 'done') ctx.log(`boot ${e.stage}: ${e.ok ? 'ok' : 'OFF'} ${e.detail} (${e.ms} ms)`); });
});

module.exports = { ctx };
