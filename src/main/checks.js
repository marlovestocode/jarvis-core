// What self_diagnostics checks (core/self/diagnostics.js): every JARVIS part, read from the live objects in ctx
// each time it runs. A check returns text (ok), off(detail) for a part that is not in use, or bad(detail).
const fs = require('node:fs');
const { inspectConfig } = require('../core/config');
const { statusSafe } = require('../core/settings');
const { SYSMON } = require('../core/tools/sysmon');
const { duration } = require('../core/tools/self');
const { storesLine } = require('../core/self/stores');

const off = detail => ({ off: true, detail });
const bad = detail => ({ ok: false, detail });
const ROLE = { stt: 'speech-to-text', tts: 'text-to-speech', wake: 'wake word' };

function selfChecks(ctx, { fetch = globalThis.fetch } = {}) {
  const cfg = () => ctx.config;

  // the engine in use for a voice role, which is not always the configured one (engine-pick.js falls back)
  const engine = kind => ({ id: ROLE[kind], run: async () => {
    if (kind === 'wake' && !cfg().wakeEnabled) return off('the wake word is off');
    const want = cfg().engines[kind];
    const e = ctx.pickEngine(kind);
    if (e.id === 'none') return bad(`no engine (${want} is set)`);
    if (e.id !== want) return bad(`${want} is set but not available; using ${e.label}`);
    const st = await statusSafe(e, 3000);
    return st.ready ? `${e.label}${st.detail ? ` (${st.detail})` : ''}` : bad(`${e.label}: ${st.detail || 'not ready'}`);
  } });

  return [
    { id: 'core', run: () => `v${ctx.version}, running for ${duration(Date.now() - ctx.startedAt)}` },
    { id: 'startup', run: () => {
      const done = ctx.bootLog.find(e => e.stage === 'done');
      if (!done) return off('still starting');
      const failed = ctx.bootLog.filter(e => e.stage !== 'done' && !e.ok).map(e => `${e.stage} (${e.detail})`);
      // each part that was off at startup has its own check below, with its state now
      return done.ok ? `${done.detail} in ${done.ms} ms` : off(`${done.detail} in ${done.ms} ms; off at startup: ${failed.join(', ')}`);
    } },
    { id: 'settings', run: () => {
      const c = inspectConfig(ctx.dataDir);
      if (c.error) return bad(`config.json cannot be read (${c.error}); defaults are in use`);
      if (c.ignored.length) return bad(`ignored or adjusted entries in config.json: ${c.ignored.join(', ')}`);
      return `${c.exists ? `${c.changed.length} changed from the defaults` : 'no config.json yet, defaults in use'}${c.broken ? '; an earlier unreadable file was set aside as config.broken.json' : ''}`;
    } },
    { id: 'data folder', run: () => {
      fs.accessSync(ctx.dataDir, fs.constants.W_OK);
      return `${ctx.dataDir} is writable`;
    } },
    { id: 'memory', run: () => {
      const m = ctx.memwatch.check();
      const f = m.components.fetchCache, w = m.components.wallpaperLink;
      const text = `${m.rssMB} MB in use (peak ${m.peakMB} MB, warns at ${m.warnMB} MB)`
        + (f ? `; lookup cache ${Math.round(f.chars / 1024)} of ${Math.round(f.capChars / 1024)} KB, ${f.evicted} dropped` : '')
        + (w?.dropped ? `; ${w.dropped} stalled wallpaper connections dropped` : '');
      return m.level === 'ok' ? text : bad(`${m.level}: ${text}`);
    } },
    // the cortex (long-term memory): opens, integrity, embedding model, index queue, last backup
    { id: 'cortex', run: () => {
      if (!ctx.memorySystem) return off('memory is not started');
      const c = ctx.memorySystem.check();
      return c.level === 'ok' ? c.detail : c.level === 'off' ? off(c.detail) : bad(c.detail);
    } },
    { id: 'model', timeoutMs: 6000, run: async () => {
      const p = ctx.providers.get(cfg().provider);
      if (!p) return bad(`unknown provider "${cfg().provider}"`);
      if (p.id === 'null') return off('no model chosen in settings');
      const st = await statusSafe(p, 5000);
      return st.ready ? `${p.label}${st.detail ? `: ${st.detail}` : ''}` : bad(`${p.label}: ${st.detail || 'not ready'}`);
    } },
    engine('stt'), engine('tts'), engine('wake'),
    { id: 'microphone', run: () => (ctx.micOk ? 'no fault reported' : bad('unavailable')) },
    { id: 'voice recognition', run: () => {
      if (!ctx.speaker.available()) return off('the speaker model is not installed');
      if (!ctx.speaker.enrolled()) return off('no voice enrolled');
      return `voice enrolled (${ctx.speaker.count()} samples), gate ${cfg().speakerGate ? 'on' : 'off'}`;
    } },
    { id: 'wallpaper link', run: () => (ctx.bridge ? `127.0.0.1:${ctx.bridge.port}, ${ctx.bridge.clients() ? 'wallpaper connected' : 'no wallpaper connected'}` : bad('the bridge did not start')) },
    { id: 'chrome extension', run: () => {
      if (!ctx.ytmLink.port) return bad('the link is not listening');
      return ctx.ytmLink.connected ? `connected on 127.0.0.1:${ctx.ytmLink.port}` : off(`not connected (listening on 127.0.0.1:${ctx.ytmLink.port})`);
    } },
    { id: 'browser skills', run: () => {
      if (!cfg().browser.enabled) return off('off in settings');
      return ctx.ytmLink.connected ? 'on' : bad('on in settings, but the Chrome extension is not connected');
    } },
    { id: 'sysmon', run: async () => {
      const r = await fetch(`${SYSMON}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      return r?.ok ? 'running' : off('not running');
    } },
    { id: 'offline library', run: async () => {
      if (!ctx.kiwix.available()) return off('not installed');
      const info = await ctx.kiwix.info();
      return `${info.file || 'installed'}${info.articles ? `, ${info.articles.toLocaleString('en-US')} articles` : ''}${info.running ? '' : ' (its server starts on first use)'}`;
    } },
    { id: 'online lookups', run: () => {
      const o = cfg().online;
      if (!o.enabled) return off('off in settings');
      const on = Object.keys(o).filter(k => k !== 'enabled' && o[k]);
      return on.length ? `on: ${on.join(', ')}` : off('every source is off');
    } },
    { id: 'pc control', timeoutMs: 8000, run: async () => {
      const n = (await ctx.pcAllowlist()).length;
      return n ? `${n} apps allowed` : bad('no apps could be read from the Start menu');
    } },
    { id: 'media', run: async () => { await ctx.media.state(); return 'reads what is playing'; } },
    { id: 'timers', run: () => `${ctx.scheduler.list().length} set` },
    // where each kind of data lives: in the cortex, in its own file, or a file mirrored from the cortex (cortex wave 3 §5)
    { id: 'data stores', run: () => storesLine() },
    { id: 'hotkeys', run: () => (ctx.hotkeys.failed.length ? bad(`taken by another app: ${ctx.hotkeys.failed.join(', ')}`) : `chat ${cfg().hotkeys.chat}, voice ${cfg().hotkeys.voice}`) },
  ];
}

module.exports = { selfChecks };
