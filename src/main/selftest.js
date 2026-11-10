// Dev-only self-test: drives the real app and writes report.json + screenshots.
// Off unless JARVIS_SELFTEST=<out dir>. JARVIS_SELFTEST_MODE picks the script.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function run(ctx, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const mode = process.env.JARVIS_SELFTEST_MODE || 'chat';
  const report = { mode, steps: [] };
  const step = (name, data) => report.steps.push({ name, ...data });
  const win = () => ctx.windows.chat;
  const js = code => win().webContents.executeJavaScript(code, true);
  const shot = async name => {
    const img = await win().webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
  };
  const dom = () => js(`({
    msgs: [...document.querySelectorAll('.msg')].map(e => e.className + ' | ' + e.textContent),
    chip: document.getElementById('chip').textContent,
    state: document.getElementById('state').textContent,
    list: [...document.querySelectorAll('#list li')].map(e => e.textContent),
    buttons: [...document.querySelectorAll('.note button')].map(b => b.textContent),
    micDisabled: document.getElementById('micBtn').disabled,
  })`);
  const type = async t => {
    await js(`(() => { const ta = document.getElementById('text'); ta.value = ${JSON.stringify(t)};
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  };
  const extra = ctx.selftestModes || {};

  try {
    await new Promise(r => (win().webContents.isLoading() ? win().webContents.once('did-finish-load', r) : r()));
    step('hotkeys', { failed: ctx.hotkeys.failed, registered: ctx.hotkeys.registered });
    step('bridge', { port: ctx.bridge?.port ?? null });
    if (mode === 'chat') {
      ctx.windows.showChat();
      await wait(600);
      await type('hi');
      await wait(2500);
      step('after hi', await dom());
      await shot('chat-hi');
      await type('/new');
      await wait(800);
      step('after /new', await dom());
      await shot('chat-new');
    } else if (mode === 'list') {
      ctx.windows.showChat();
      await wait(1000);
      step('list', await dom());
      await shot('chat-list');
    } else if (mode === 'orb') {
      ctx.windows.showChat();
      await wait(600);
      await type('hello orb');
      await wait(90);
      await shot('orb-streaming');
      await wait(2000);
      ctx.bus.emit('state', { state: 'error', detail: 'selftest' });
      await wait(60);
      await shot('orb-error');
      ctx.bus.emit('state', { state: 'idle' });
      step('orb', await dom());
    } else if (mode === 'voice') {
      // Real STT/TTS through the speech host; synthesized speech is fed instead of the mic.
      const os = require('node:os');
      ctx.mic.start = () => {}; ctx.mic.stop = () => {};
      step('speech status', await ctx.speechHost.request('status'));
      const wav = path.join(os.tmpdir(), 'jarvis-selftest-voice.wav');
      await ctx.speechHost.request('synth', { wav, text: 'What time is it' });
      const buf = fs.readFileSync(wav); fs.rmSync(wav, { force: true });
      const speech = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length - ((buf.length - 44) % 2)));
      const quiet = ms => { const a = new Int16Array(16 * ms); for (let i = 0; i < a.length; i++) a[i] = (Math.random() - .5) * 200; return a; };
      const all = new Int16Array([...quiet(300), ...speech, ...quiet(900)]);
      const states = [];
      ctx.bus.on('state', e => states.push(e.state + (e.detail ? ':' + e.detail : '')));
      ctx.startVoice();
      await wait(300);
      for (let o = 0; o + 320 <= all.length; o += 320) ctx.voice.feed(all.subarray(o, o + 320), 16000);
      const t0 = Date.now();
      while (!ctx.voice.speaking && Date.now() - t0 < 15000) await wait(50);
      const s = ctx.sessions.load(ctx.sessionId);
      step('voice turn', { speaking: ctx.voice.speaking, ms: Date.now() - t0, lastUser: s?.messages.filter(m => m.role === 'user').at(-1)?.content, reply: s?.messages.at(-1)?.content });
      await wait(1200);
      await shot('voice-speaking');
      const t1 = Date.now();
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      while (ctx.voice.speaking && Date.now() - t1 < 3000) await wait(20);
      step('esc while speaking', { stillSpeaking: ctx.voice.speaking, ms: Date.now() - t1, states });
    } else if (mode === 'mic-bad') {
      ctx.config = { ...ctx.config, micDeviceId: 'no-such-device' };
      ctx.windows.showChat();
      await wait(500);
      ctx.startVoice();
      await wait(2500);
      step('mic-bad', { voiceActive: ctx.voice.active, ...(await dom()) });
      await shot('mic-bad');
    } else if (mode === 'mic') {
      let frames = 0, rmsMax = 0;
      const realFeed = ctx.voice.feed;
      ctx.voice.feed = (pcm, rate) => { frames++; for (const v of pcm) rmsMax = Math.max(rmsMax, Math.abs(v) / 32768); };
      const st = [];
      ctx.bus.on('mic', e => st.push(e));
      ctx.mic.start();
      await wait(2500);
      ctx.mic.stop();
      ctx.voice.feed = realFeed;
      step('mic', { frames, peak: +rmsMax.toFixed(4), status: st });
      await wait(300);
      step('chat', await dom());
    } else if (mode === 'hotkey') {
      const t0 = Date.now();
      while (!win().isVisible() && Date.now() - t0 < 15000) await wait(100);
      step('visible after hotkey', { visible: win().isVisible(), ms: Date.now() - t0 });
      if (win().isVisible()) await shot('chat-hotkey');
    } else if (extra[mode]) {
      await extra[mode]({ ctx, step, js, dom, type, shot, wait });
    } else {
      step('unknown mode', {});
    }
  } catch (err) {
    step('error', { message: err.message, stack: err.stack });
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
}

module.exports = { run };
