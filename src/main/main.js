// JARVIS core: Electron shell around src/core. Local only.
const path = require('node:path');
const fs = require('node:fs');
const { app, globalShortcut, session, Notification } = require('electron');

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
const skills = require('../core/skills');
const { createHardwareProbe } = require('../core/brain/hardware');
const { runBoot } = require('../core/boot');
const { createTimerStore } = require('../core/timers/store');
const { createScheduler } = require('../core/timers/scheduler');
const { createProactiveEngine } = require('../core/proactive/engine');
const { createPcHost, SCRIPT: PC_HOST_SCRIPT } = require('../core/pc/host');
const { buildAllowlist } = require('../core/pc/apps');
const { createConfirm } = require('../core/pc/confirm');
const { createActionLog } = require('../core/pc/actions-log');
const { createOrchestrator } = require('../core/orchestrator');
const { createPolicy } = require('../core/net/policy');
const { createFetcher } = require('../core/net/fetcher');
const { createKiwix } = require('../core/knowledge/kiwix');
const { startBridge } = require('../core/bridge');
const { createEngineRegistries } = require('../core/voice/engines');
const { createSpeechHost, windowsTts, windowsStt, windowsWake } = require('../core/voice/windows-speech');
const { createVoiceController } = require('../core/voice/controller');
const { createWhisperStt, whisperModelPath, pickSttModel } = require('../core/voice/whisper');
const { sttPrompt, withTerms } = require('../core/voice/stt-prompt');
const { createPiperTts } = require('../core/voice/piper');
const { createModelVad } = require('../core/voice/vad-model');
const { createEnginePick } = require('../core/voice/engine-pick');
const { createSileroProvider } = require('../core/voice/silero-provider');
const { chime } = require('../core/voice/chime');
const { createMediaService } = require('../core/media/service');
const { createMediaSkill } = require('../core/media/skill');
const { promptLine: mediaPromptLine } = require('../core/media/say');
const { pressKey } = require('../core/tools/media');
const { startYtMusicLink } = require('../core/media/ytmusic-link');
const { createYtMusic } = require('../core/media/ytmusic');
const { createYtPlaylists } = require('../core/media/ytplaylists');
const { createSpeaker } = require('../core/voice/speaker/speaker');
const { enrollVoice } = require('../core/voice/speaker/enroll');
const { createPlayLog } = require('../core/music/log');
const { createMemory } = require('../core/memory/store');
const { createMemorySkill } = require('../core/memory/skill');
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
    youtubeMusic: ctx.ytmLink.connected ? 'extension connected' : 'extension not connected',
    wallpaper: ctx.bridge ? (ctx.bridge.clients() ? 'linked to the core' : 'not connected') : 'bridge off',
    voice: `speech-to-text ${c.engines.stt}, text-to-speech ${c.engines.tts}, wake word ${c.wakeEnabled ? 'on' : 'off'}`,
    hotkeys: ctx.hotkeys.failed.length ? `taken: ${ctx.hotkeys.failed.join(', ')}` : `chat ${c.hotkeys.chat}, voice ${c.hotkeys.voice}`,
  };
}
ctx.fetcher = createFetcher({ policy: createPolicy(ctx.getConfig), bus: ctx.bus, cacheDir: path.join(DATA_DIR, 'cache') });
ctx.kiwix = createKiwix({ exe: path.join(__dirname, '../../engines/kiwix/kiwix-serve.exe'), zimDir: 'C:\\JarvisData\\library', log: ctx.log });
// Media: what is playing and its controls, read from Windows by one PowerShell host (src/core/media).
// Media keys through sysmon remain the fallback when the host cannot run.
ctx.mediaHost = createSpeechHost({ script: path.join(__dirname, '../core/media/media-host.ps1'), log: ctx.log, name: 'media host' });
ctx.media = createMediaService({ request: (cmd, args) => ctx.mediaHost.request(cmd, args), keys: key => pressKey(fetch, key), log: ctx.log });
// YouTube Music: the JARVIS Chrome extension connects here (127.0.0.1:47830, extension origin only)
// every finished play the extension reports goes into the local listening log (music_stats)
ctx.playLog = createPlayLog({ file: path.join(DATA_DIR, 'music-plays.jsonl'), getConfig: ctx.getConfig, log: ctx.log });
ctx.ytmLink = startYtMusicLink({ log: ctx.log, onChange: connected => ctx.ytPlaylists?.onLink(connected), onPlay: e => ctx.playLog.add(e) });
ctx.ytm = createYtMusic({ link: ctx.ytmLink });
// the user's own playlists, read live through the extension (library hint kept on disk for the prompt)
ctx.ytPlaylists = createYtPlaylists({ link: ctx.ytmLink, ytm: ctx.ytm, getConfig: ctx.getConfig, file: path.join(DATA_DIR, 'cache', 'ytm-library.json'), journalFile: path.join(DATA_DIR, 'ytm-undo.json'), log: ctx.log });
ctx.mediaSkill = createMediaSkill({ service: ctx.media, ytm: ctx.ytm, ytPlaylists: ctx.ytPlaylists });
if (!DEV_RUN) ctx.media.state().catch(err => ctx.log('media host:', err.message));   // warm up: the first read compiles Core Audio (~0.8 s)
ctx.memory = createMemory({ file: path.join(DATA_DIR, 'memory.json'), log: ctx.log });
ctx.memorySkill = createMemorySkill({ memory: ctx.memory, setName: name => ctx.saveConfig({ ...ctx.config, user: { ...ctx.config.user, name } }) });
// What JARVIS can do right now, from live state: the model must not deny these or claim what is not here.
function capsLine() {
  const c = ctx.config, on = v => (v ? 'on' : 'off');
  return [
    `wake word "Jarvis" is ${on(c.wakeEnabled)} (also the voice hotkey ${c.hotkeys.voice})`,
    `recognises the owner's voice: ${ctx.speaker.enrolled() ? (c.speakerGate ? 'enrolled, only they can wake it' : 'enrolled, gate off') : 'not enrolled'}`,
    `YouTube Music extension: ${ctx.ytmLink.connected ? 'connected' : 'not connected'}`,
    `listening log: ${c.music.logPlays ? `${ctx.playLog.count()} plays recorded${ctx.playLog.since() ? ` since ${new Date(ctx.playLog.since()).toLocaleDateString('en-US')}` : ''}` : 'off'} (music_stats tool)`,
    skills.capsLine(ctx.catalog),   // every skill group; risky PC actions ask the user first, timers are spoken when they fire
    `speech-to-text ${c.engines.stt}${c.sttGpu ? ' on GPU' : ''}, saved memory of the user`,
  ].join('; ') + '.';
}
function userInfo() {
  const c = ctx.config;
  return {
    name: c.user.name, about: c.user.about, city: c.location.city, units: c.location.units,
    teams: c.sports.follow.map(f => f.team), playlists: ctx.ytPlaylists.count?.() || 0, voiceEnrolled: ctx.speaker.enrolled(),
  };
}
// timers, alarms and reminders: <data>/timers.json; firing puts 'timer' on the bus (started in the boot stage)
// PC control: one PowerShell host for apps/windows/Recycle Bin; risky actions wait for the user's yes
ctx.pcHostProc = createSpeechHost({ script: PC_HOST_SCRIPT, log: ctx.log, name: 'pc host' });
ctx.pcHost = createPcHost({ request: (cmd, args) => ctx.pcHostProc.request(cmd, args) });
ctx.pcStartApps = null;   // Start menu list, read at boot and then every 10 minutes when asked
ctx.pcStartAt = 0;
async function pcAllowlist() {
  if (!ctx.pcStartApps || Date.now() - ctx.pcStartAt > 600000) {
    try { ctx.pcStartApps = await ctx.pcHost.startApps(); ctx.pcStartAt = Date.now(); } catch (err) { ctx.log('start menu apps:', err.message); ctx.pcStartApps = ctx.pcStartApps || []; }
  }
  return buildAllowlist(ctx.pcStartApps, ctx.config.pc.apps);
}
// the user's own folders, where Windows really keeps them (Documents may live in OneDrive)
ctx.pcRoots = [app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads'), path.join(app.getPath('home'), 'Projects')];
ctx.actionLog = createActionLog({ file: path.join(DATA_DIR, 'actions.log'), log: ctx.log });
ctx.confirm = createConfirm({ actionLog: ctx.actionLog });
ctx.timerStore = createTimerStore({ file: path.join(DATA_DIR, 'timers.json'), log: ctx.log });
ctx.scheduler = createScheduler({ store: ctx.timerStore, bus: ctx.bus, log: ctx.log });
ctx.catalog = brain.defaultCatalog({ capture: { dir: path.join(app.getPath('pictures'), 'JARVIS') }, memory: ctx.memory, playLog: ctx.playLog, getStatus: jarvisStatus, fetcher: ctx.fetcher, kiwix: ctx.kiwix, getConfig: ctx.getConfig, bus: ctx.bus, media: ctx.media, ytm: ctx.ytm, ytPlaylists: ctx.ytPlaylists, scheduler: ctx.scheduler, pc: { host: ctx.pcHost, getAllowlist: pcAllowlist, roots: ctx.pcRoots, confirm: ctx.confirm, actionLog: ctx.actionLog } });
ctx.toolList = ctx.catalog.tools;
ctx.tools = createToolRunner(ctx.toolList, { groups: ctx.catalog.groups });
ctx.orchestrator = createOrchestrator({
  bus: ctx.bus, sessions: ctx.sessions, providers: ctx.providers, tools: ctx.tools, getConfig: ctx.getConfig,
  systemPrompt: brain.systemPrompt, route: brain.route,
  selectGroups: (text, o) => skills.selectGroups(text, o, ctx.catalog),
  // the model always sees what is playing, read fresh for the turn (skipped if Windows is slow)
  promptInfo: async () => {
    let media;
    try { media = mediaPromptLine(await Promise.race([ctx.media.state(), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 600))])); } catch { media = undefined; }
    return { hardware: ctx.hardware.cached() || undefined, media, library: ctx.ytPlaylists.digest() || undefined, memory: ctx.memory.digest() || undefined, user: userInfo(), caps: capsLine() };
  },
  // a pending PC action reads the user's own reply first (yes / no); nothing else can confirm it
  fastPath: async (text, o) => (await ctx.confirm.handle(text, o)) || (await ctx.memorySkill.handle(text, o)) || ctx.mediaSkill.handle(text, o),
  onQuestionLost: () => ctx.confirm.clear(),
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
  exe: path.join(ENGINES, 'whisper', 'bin', 'Release', 'whisper-server.exe'), model: whisperModelPath({ dir: path.join(ENGINES, 'whisper'), name: pickSttModel(ctx.config), log: ctx.log }),
  cpuModel: path.join(ENGINES, 'whisper', 'ggml-base.en.bin'), gpu: ctx.config.sttGpu,
  // the user's own words (playlists, teams, name) are added each time, so new playlists are heard right
  prompt: () => withTerms(sttPrompt(ctx.config.sttPrompt), [ctx.config.user.name, ...ctx.ytPlaylists.titles(), ...ctx.config.sports.follow.map(f => f.team)]), log: ctx.log,
});
ctx.piper = createPiperTts({
  exe: path.join(ENGINES, 'piper', 'bin', 'piper', 'piper.exe'), model: path.join(ENGINES, 'piper', 'en_GB-alan-medium.onnx'),
  outDir: path.join(os.tmpdir(), 'jarvis-tts'), play: (pcm, rate, o) => ctx.mic.play(pcm, rate, o), log: ctx.log,
});
ctx.engines.stt.add(ctx.whisper);
ctx.engines.tts.add(ctx.piper);
// wake word heard by Whisper on the mic chosen in settings (Windows' recognizer only hears the default device)
ctx.engines.wake.add({
  id: 'whisper', label: 'Whisper on your mic', kind: 'listen',
  available: () => ctx.whisper.available(),
  status: async () => (ctx.whisper.available() ? { ready: true, detail: 'Listens on the selected mic' } : { ready: false, detail: 'Whisper is not installed' }),
});
// configured engine → Windows → None; each fallback logs its reason once (it used to be silent)
const engine = createEnginePick({ registries: ctx.engines, getConfig: ctx.getConfig, log: ctx.log });
// Silero VAD when config.vad is 'silero': one shared model, own state per VAD; energy VAD otherwise or on failure
ctx.sileroVad = createSileroProvider({ modelPath: path.join(ENGINES, 'vad', 'silero_vad.onnx'), isOn: () => ctx.config.vad === 'silero', log: ctx.log });
ctx.sileroVad.getModel();   // start loading now so the first capture already has it
// who is speaking: the enrolled voice print, kept in the data folder (never leaves this PC)
ctx.speaker = createSpeaker({
  ort: require('onnxruntime-node'), modelPath: path.join(ENGINES, 'speaker', 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
  profileFile: path.join(DATA_DIR, 'voiceprint.json'), getConfig: ctx.getConfig, log: ctx.log,
});
ctx.voice = createVoiceController({
  bus: ctx.bus, orchestrator: ctx.orchestrator, speaker: ctx.speaker,
  engines: { stt: () => engine('stt'), tts: () => engine('tts'), wake: () => engine('wake') },
  getConfig: ctx.getConfig, getSessionId: () => ctx.sessionId, setSessionId: id => { ctx.sessionId = id; },
  vadOptions: { silenceMs: ctx.config.endSilenceMs }, // config.endSilenceMs; read at start
  vadFactory: opts => createModelVad({ ...opts, getModel: ctx.sileroVad.getModel, onError: ctx.sileroVad.onError }),
  writeTrace: sum => fs.appendFile(path.join(app.getPath('userData'), 'voice-trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...sum }) + '\n', () => {}),
});
ctx.micOk = true;
ctx.startVoice = () => {
  ctx.windows.showChat();
  if (!ctx.micOk) { ctx.mic?.start(); } // retry: the mic may be back
  ctx.voice.listen();
};
// JARVIS speaks unasked (timers): waits while you talk, quiet hours / DND give a toast only
ctx.proactive = createProactiveEngine({
  bus: ctx.bus, getConfig: ctx.getConfig, log: ctx.log,
  speak: text => ctx.voice.announce(text),
  chime: () => { ctx.mic?.play(chime(), 22050).catch(() => {}); },
  notify: (title, body) => {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    else ctx.tray?.displayBalloon?.({ title, content: body });
  },
  appendHistory: msg => {
    let s = ctx.sessionId ? ctx.sessions.load(ctx.sessionId) : null;
    if (!s) { s = ctx.sessions.create(); ctx.sessionId = s.id; }
    s.messages.push(msg);
    ctx.sessions.save(s);
  },
});
ctx.bus.on('log', ev => ctx.log(ev.text));
// "Jarvis" heard: a short chime says it is listening (the orb flares too)
ctx.bus.on('wake', () => { ctx.log('wake word heard'); ctx.mic?.play(chime(), 22050).catch(() => {}); });
ctx.updateMic = () => { if (!ctx.mic) return; if (ctx.voice.active || ctx.config.wakeEnabled) ctx.mic.start(); else ctx.mic.stop(); };
// mic open only while voice is active
ctx.bus.on('state', () => {
  if (!ctx.mic) return;
  // with the wake word on, the mic stays open (local only) so "Jarvis, <command>" keeps its first words
  if (ctx.voice.active || ctx.config.wakeEnabled) ctx.mic.start(); else ctx.mic.stop();
});
ctx.onQuit = [() => ctx.scheduler.stop(), () => ctx.pcHostProc.close(), () => ctx.speechHost.close(), () => ctx.mediaHost.close(), () => ctx.ytmLink.close(), () => ctx.mic?.destroy(), () => ctx.whisper.close(), () => ctx.piper.close(), () => ctx.kiwix.close()];

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
    onOpen: mode => { ctx.log(`open from wallpaper: ${mode}`); if (mode === 'voice') ctx.startVoice(); else ctx.windows?.showChat(); },
  });
  bridgeStarting.catch(() => {});

  // only our own pages may use the mic; nothing else gets any permission
  const own = wc => { try { return new URL(wc.getURL()).protocol === 'file:'; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && own(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && !!wc && own(wc));

  ctx.windows = createWindows({ hideOnBlur: !process.env.JARVIS_SELFTEST });
  ctx.mic = createMic({
    getDeviceId: () => ctx.config.micDeviceId,
    onFrame: (pcm, rate) => { if (ctx.enrollBuf) ctx.enrollBuf.push({ pcm: Int16Array.from(pcm), rate }); else ctx.voice.feed(pcm, rate); },
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
  ctx.enrollVoice = () => enrollVoice(ctx);
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
    { stage: 'online', run: async () => `allowlisted lookups ${ctx.config.online.enabled ? 'on' : 'off'}` },
    { stage: 'library', run: async () => {
      if (!ctx.kiwix.available()) return { ok: false, detail: 'not installed (online Wikipedia available when allowed)' };
      if (!await ctx.kiwix.warm()) return { ok: false, detail: 'offline Wikipedia server unavailable' };
      const info = await ctx.kiwix.info();
      return `offline Wikipedia${info.articles ? ` (${info.articles.toLocaleString()} articles)` : ''}`;
    } },
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
    { stage: 'pc', run: async () => `${(await pcAllowlist()).length} apps allowed` },
    { stage: 'timers', run: async () => { const r = ctx.scheduler.start(); return `${r.armed} set${r.fired ? `, ${r.fired} missed while off` : ''}`; } },
    { stage: 'sysmon', run: async () => {
      const r = await fetch('http://127.0.0.1:47800/health', { signal: AbortSignal.timeout(1000) }).catch(() => null);
      return r?.ok ? 'linked' : { ok: false, detail: 'not running' };
    } },
    { stage: 'voice', run: async () => {
      ctx.voice.applyWake();
      ctx.updateMic();
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
