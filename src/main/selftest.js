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
      await wait(300);
      const tIdle = Date.now();
      while (ctx.orchestrator.busy && Date.now() - tIdle < 90000) await wait(200);
      await wait(300);
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
    } else if (mode === 'brain') {
      const seen = [];
      ctx.bus.on('*', e => { if (['boot', 'route', 'turn', 'tool'].includes(e.type)) seen.push(e); });
      ctx.windows.showChat();
      const tb = Date.now();
      while (!seen.some(e => e.type === 'boot' && e.stage === 'done') && Date.now() - tb < 60000) await wait(100);
      step('boot', { ms: Date.now() - tb, stages: seen.filter(e => e.type === 'boot').map(e => `${e.stage}:${e.ok ? 'ok' : 'off'}:${e.detail}:${e.ms}ms`) });
      for (const q of ['hello jarvis', 'What is the energy of a photon with wavelength 500 nm, in electronvolts?']) {
        seen.length = 0;
        await type(q);
        await wait(300);
        const t0 = Date.now();
        while (ctx.orchestrator.busy && Date.now() - t0 < 120000) await wait(100);
        await wait(400);
        const s = ctx.sessions.load(ctx.sessionId);
        step('ask', { q, ms: Date.now() - t0, route: seen.find(e => e.type === 'route'), turn: seen.find(e => e.type === 'turn'),
          tools: seen.filter(e => e.type === 'tool' && e.phase === 'end').map(e => `${e.name}:${e.ok}`), reply: s.messages.at(-1)?.content });
        await shot('brain-' + (q.length > 20 ? 'physics' : 'hello'));
      }
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
      while (!ctx.voice.speaking && Date.now() - t0 < 30000) await wait(10);
      step('first speech', { msFromEndOfSpeech: Date.now() - t0, stt: ctx.engines.stt.get(ctx.config.engines.stt)?.label, tts: ctx.engines.tts.get(ctx.config.engines.tts)?.label });
      const s = ctx.sessions.load(ctx.sessionId);
      step('voice turn', { speaking: ctx.voice.speaking, ms: Date.now() - t0, lastUser: s?.messages.filter(m => m.role === 'user').at(-1)?.content, reply: s?.messages.at(-1)?.content });
      await wait(1200);
      await shot('voice-speaking');
      const t1 = Date.now();
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      while (ctx.voice.speaking && Date.now() - t1 < 3000) await wait(20);
      step('esc while speaking', { stillSpeaking: ctx.voice.speaking, ms: Date.now() - t1, states: states.slice() });
      // second turn: let the reply finish on its own
      states.length = 0;
      ctx.voice.listen();
      for (let o = 0; o + 320 <= all.length; o += 320) ctx.voice.feed(all.subarray(o, o + 320), 16000);
      const t2 = Date.now();
      let tSpeak = 0;
      while (states.at(-1) !== 'idle' && Date.now() - t2 < 20000) { if (!tSpeak && ctx.voice.speaking) tSpeak = Date.now() - t2; await wait(10); }
      step('natural end', { states, warmFirstSpeechMs: tSpeak, totalMs: Date.now() - t2 });
    } else if (mode === 'settings') {
      const { globalShortcut } = require('electron');
      const sw = ctx.windows.showSettings();
      if (sw.webContents.isLoading()) await new Promise(r => sw.webContents.once('did-finish-load', r));
      await wait(1500);
      fs.writeFileSync(path.join(outDir, 'progress.txt'), 'loaded\n');
      const sjs = c => sw.webContents.executeJavaScript(c, true);
      const read = () => sjs(`({ provider: [...document.querySelectorAll('#provider option')].map(o => o.textContent), providerDetail: document.getElementById('providerDetail').textContent,
        stt: [...document.querySelectorAll('#stt option')].map(o => o.textContent), tts: document.getElementById('tts').value, wake: document.getElementById('wake').value,
        mics: document.querySelectorAll('#mic option').length, rate: document.getElementById('rate').value, hkChat: document.getElementById('hkChat').value, hkWarn: document.getElementById('hkWarn').textContent,
        modelRowHidden: document.getElementById('modelRow').hidden, model: document.getElementById('model').value, models: [...document.querySelectorAll('#model option')].map(o => o.textContent) })`);
      step('settings open', await read());
      fs.appendFileSync(path.join(outDir, 'progress.txt'), 'read\n');
      fs.writeFileSync(path.join(outDir, 'settings.png'), (await sw.webContents.capturePage()).toPNG());
      const res = await sjs(`window.jarvis.settings.set({ voiceRate: 1.6, hotkeys: { chat: 'Control+Alt+J' } })`);
      step('after set', { errors: res.errors, rate: res.config.voiceRate, hotkeys: res.config.hotkeys,
        ctrlSpaceRegistered: globalShortcut.isRegistered('Control+Space'), ctrlAltJRegistered: globalShortcut.isRegistered('Control+Alt+J'),
        file: JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'config.json'), 'utf8')) });
      // the next spoken reply uses the new rate
      const seen = [];
      const realReq = ctx.speechHost.request;
      ctx.speechHost.request = (cmd, args) => { if (cmd === 'speak') seen.push(args.rate); return realReq(cmd, args); };
      const h = ctx.engines.tts.get('windows').speak('Rate check.', { rate: ctx.config.voiceRate });
      await Promise.race([h.done, wait(10000)]);
      step('speak rate', { sapiRate: seen });
    } else if (mode === 'knowledge') {
      const assert = require('node:assert/strict');
      await ctx.booted;
      const original = structuredClone(ctx.config);
      const sw = ctx.windows.showSettings();
      if (sw.webContents.isLoading()) await new Promise(r => sw.webContents.once('did-finish-load', r));
      const sjs = code => sw.webContents.executeJavaScript(code, true);
      const settled = async () => {
        const start = Date.now();
        while (await sjs(`document.querySelector('.body').inert`) && Date.now() - start < 15000) await wait(50);
        await wait(100);
      };
      const change = async (id, value) => {
        await sjs(`(() => { const e = document.getElementById(${JSON.stringify(id)}); ${typeof value === 'boolean' ? 'e.checked' : 'e.value'} = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await settled();
      };
      const submit = async (id, values) => {
        await sjs(`(() => { for (const [id, value] of Object.entries(${JSON.stringify(values)})) document.getElementById(id).value = value; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); })()`);
        await settled();
      };
      try {
        await wait(800);
        await change('onlineEnabled', false);
        assert.equal(ctx.config.online.enabled, false);
        assert.equal(await sjs(`document.getElementById('placeSearch').disabled`), true);
        const blocked = await sjs(`window.jarvis.settings.places('Dallas')`);
        assert.match(blocked.error, /off/i);
        await change('onlineEnabled', true);
        for (const [id, key] of [['onlineWeather', 'weather'], ['onlineNews', 'news'], ['onlineSports', 'sports'], ['onlineWiki', 'wiki']]) {
          await change(id, false); assert.equal(ctx.config.online[key], false);
          await change(id, true); assert.equal(ctx.config.online[key], true);
        }
        await change('units', 'C'); assert.equal(ctx.config.location.units, 'C');
        await submit('placeForm', { placeQuery: 'Springfield' });
        const started = Date.now();
        while (await sjs(`document.getElementById('placeSearch').disabled`) && Date.now() - started < 15000) await wait(100);
        const choices = await sjs(`[...document.querySelectorAll('#placePick option')].map(e => ({ value: e.value, text: e.textContent }))`);
        assert.ok(choices.length > 2, JSON.stringify(choices));
        await change('placePick', choices.find(e => /Illinois/.test(e.text))?.value || choices[1].value);
        assert.match(ctx.config.location.city, /Springfield/);
        step('location and switches', { choices, location: ctx.config.location });
        await submit('placeForm', { placeQuery: 'Qwxzzyplk' });
        const unknown = Date.now();
        while (await sjs(`document.getElementById('placeSearch').disabled`) && Date.now() - unknown < 15000) await wait(100);
        assert.equal(await sjs(`document.getElementById('placeRow').hidden`), true);
        const beforeFeeds = ctx.config.news.feeds.length;
        await submit('feedForm', { feedUrl: 'http://localhost/rss' });
        assert.equal(ctx.config.news.feeds.length, beforeFeeds);
        assert.equal(await sjs(`document.getElementById('errors').hidden`), false);
        await submit('feedForm', { feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml' });
        assert.equal(ctx.config.news.feeds.length, beforeFeeds + 1);
        await sjs(`document.querySelector('#feeds li:last-child button').click()`); await settled();
        assert.equal(ctx.config.news.feeds.length, beforeFeeds);
        const beforeTeams = ctx.config.sports.follow.length;
        await submit('teamForm', { teamLeague: 'nfl', teamName: 'Cowboys' });
        assert.equal(ctx.config.sports.follow.length, beforeTeams + 1);
        await sjs(`document.querySelector('#teams li:last-child button').click()`); await settled();
        assert.equal(ctx.config.sports.follow.length, beforeTeams);
        step('feed/team add-remove and invalid feed', { ok: true, library: await ctx.kiwix.info() });
        await sjs(`document.getElementById('knowledge').scrollIntoView()`);
        fs.writeFileSync(path.join(outDir, 'knowledge-settings.png'), (await sw.webContents.capturePage()).toPNG());
      } finally {
        ctx.saveConfig(original);
        sw.close();
      }
      const seen = [];
      ctx.bus.on('*', e => { if (['tool', 'net', 'route'].includes(e.type)) seen.push(e); });
      ctx.windows.showChat();
      for (const q of ["What's the weather like in Abilene, TX?", 'Any severe weather alerts in Abilene, TX?']) {
        await js(`window.jarvis.newChat()`);
        await type(q);
        await wait(300);
        const start = Date.now();
        while (ctx.orchestrator.busy && Date.now() - start < 120000) await wait(100);
        await wait(500);
        const current = await js(`window.jarvis.current()`);
        step('live lookup', { q, answer: current.messages.at(-1), tools: seen.filter(e => e.type === 'tool'), net: seen.filter(e => e.type === 'net'), dom: await dom(), notes: await js(`[...document.querySelectorAll('.lookup-note')].map(e => e.textContent)`) });
        await shot(/alerts/.test(q) ? 'knowledge-alerts' : 'knowledge-weather');
        seen.length = 0;
      }
    } else if (mode === 'wake') {
      // idle mic hears "Jarvis, what time is it?" and then unrelated speech; mic is fed by hand
      const os = require('node:os');
      ctx.mic.start = () => {}; ctx.mic.stop = () => {};
      ctx.config = { ...ctx.config, wakeEnabled: true, engines: { ...ctx.config.engines, wake: 'whisper' } };
      ctx.voice.applyWake();
      const said = async text => {
        const wav = path.join(os.tmpdir(), 'jarvis-selftest-wake.wav');
        await ctx.speechHost.request('synth', { wav, text });
        const b = fs.readFileSync(wav); fs.rmSync(wav, { force: true });
        const speech = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)));
        const quiet = ms => { const a = new Int16Array(16 * ms); for (let i = 0; i < a.length; i++) a[i] = (Math.random() - .5) * 200; return a; };
        const all = new Int16Array([...quiet(400), ...speech, ...quiet(800)]);
        for (let o = 0; o + 320 <= all.length; o += 320) { ctx.voice.feed(all.subarray(o, o + 320), 16000); if (o % 3200 === 0) await wait(1); }
      };
      const ev = [];
      ctx.bus.on('*', e => { if (['wake', 'state'].includes(e.type)) ev.push(e.type === 'wake' ? `wake:${e.text}` : `state:${e.state}`); });
      await said('I was talking about the weather with a friend.');
      await wait(1500);
      step('unrelated speech', { events: ev.slice(), mode: ctx.voice.mode });
      ev.length = 0;
      const t0 = Date.now();
      await said('Jarvis, what time is it?');
      while (!ctx.voice.speaking && Date.now() - t0 < 20000) await wait(20);
      const firstSpeech = Date.now() - t0;
      while (ctx.voice.active && Date.now() - t0 < 30000) await wait(50);
      const s = ctx.sessions.load(ctx.sessionId);
      step('wake + command', { events: ev, msToFirstSpeech: firstSpeech, asked: s?.messages.filter(m => m.role === 'user').at(-1)?.content, reply: s?.messages.at(-1)?.content });
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
    } else if (mode === 'self') {
      // the introspection tools against the real app, once the boot has finished
      await ctx.booted;
      const scope = ctx.tools.turn(['core', 'self']);
      for (const [name, args] of [['self_diagnostics', {}], ['skills_list', {}], ['skills_list', { group: 'self' }], ['self_config', {}], ['self_log', { show: 'all', lines: 30 }], ['self_log', {}]]) {
        const t0 = Date.now();
        const r = await scope.run(name, args, { turn: { source: 'text', tainted: false } });
        step(name, { args, ok: r.ok, ms: Date.now() - t0, text: r.text });
      }
    } else if (mode === 'soak') {
      // Memory soak: the real app and chat window, a scripted model, a synthetic load every few seconds (a chat turn through
      // the page, a burst of mic levels, one play, one PC action). One snapshot a minute goes to <out>/soak.jsonl.
      // JARVIS_SOAK_MINUTES (default 20). Run it with JARVIS_DATA_DIR set: it writes chats and logs there.
      await ctx.booted;
      const minutes = Number(process.env.JARVIS_SOAK_MINUTES) || 20;
      const reply = 'Sure. Here is a **short** answer with `code`, a list:\n- one\n- two\nand a few more words to fill a line. '.repeat(3);
      ctx.providers.add({
        id: 'soak', label: 'Soak', capabilities: { tools: false },
        async status() { return { ready: true, contextMax: 8192 }; },
        async *chat() { for (let i = 0; i < reply.length; i += 12) { await wait(2); yield { type: 'token', text: reply.slice(i, i + 12) }; } yield { type: 'done', usage: {} }; },
      });
      ctx.config = { ...ctx.config, provider: 'soak', wakeEnabled: false };
      ctx.windows.showChat();
      await wait(800);
      const file = path.join(outDir, 'soak.jsonl');
      const t0 = Date.now();
      const snap = n => {
        const m = ctx.memwatch.snapshot();
        const procs = app.getAppMetrics().map(p => ({ type: p.type, wsMB: Math.round(p.memory.workingSetSize / 1024) }));
        const line = { minute: n, rssMB: m.rssMB, heapMB: m.heapMB, externalMB: m.externalMB, level: m.level, procs, parts: m.components, chatMsgs: ctx.sessions.load(ctx.sessionId)?.messages.length ?? 0 };
        fs.appendFileSync(file, JSON.stringify(line) + '\n');
        return line;
      };
      snap(0);
      let turns = 0, nextSnap = 1, last = null;
      while (Date.now() - t0 < minutes * 60000) {
        await type('soak question ' + (++turns));
        for (let i = 0; i < 150; i++) ctx.bus.emit('level', { source: 'mic', rms: Math.random() * 0.1 });
        ctx.playLog.add({ videoId: 'vid' + String(turns % 500).padStart(6, '0'), startedAt: Date.now() - 200000, listenedMs: 180000, duration: 200, title: 'Song ' + (turns % 500), artist: 'Artist ' + (turns % 50), reason: 'ended' });
        ctx.actionLog.write({ what: 'focus', args: { name: 'App ' + turns }, result: 'ok', ok: true });
        const t1 = Date.now();
        while (ctx.orchestrator.busy && Date.now() - t1 < 30000) await wait(50);
        await wait(2500);
        if ((Date.now() - t0) / 60000 >= nextSnap) { last = snap(nextSnap); nextSnap++; }
      }
      last = snap(Math.round((Date.now() - t0) / 600) / 100);   // the minute, to 0.01
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      step('soak', { minutes, turns, first: rows[0], last, peakRssMB: Math.max(...rows.map(r => r.rssMB)), snapshots: rows.length });
    } else if (mode === 'ttft') {
      // Where a voice turn's wait goes: send → provider call (our own work) → first token (the model). Every /api/chat body is
      // saved to <out>/body-N.json so the model's own timings can be read by replaying it against Ollama.
      await ctx.booted;
      const realFetch = globalThis.fetch;
      let bodies = 0, fetchAt = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/api/chat')) { fetchAt = Date.now(); fs.writeFileSync(path.join(outDir, `body-${++bodies}.json`), init.body); }
        return realFetch(url, init);
      };
      const rounds = [];
      for (const q of (process.env.JARVIS_TTFT_QUESTIONS || 'tell me a joke|what is the capital of France|how far away is the moon|turn the volume down a bit').split('|')) {
        for (let rep = 0; rep < 2; rep++) {
          const ev = {}; let first = 0, firstTool = 0;
          const off = ctx.bus.on('*', e => {
            const now = Date.now();
            if (e.type === 'state' && e.state === 'thinking') ev.thinking = now;
            if (e.type === 'route') { ev.route = now; ev.tier = e.tier; ev.think = e.think; }
            if (e.type === 'token' && !first) first = now;
            if (e.type === 'tool' && e.phase === 'start' && !firstTool) firstTool = now;
          });
          bodies = bodies; fetchAt = 0;
          const t0 = Date.now();
          const res = await ctx.orchestrator.send(null, q, { source: 'voice' });
          off();
          rounds.push({ q, rep, tier: ev.tier, think: ev.think, toThinkingMs: ev.thinking - t0, toRouteMs: ev.route - t0, toFetchMs: fetchAt ? fetchAt - t0 : null, toFirstTokenMs: first ? first - t0 : null, fetchToFirstTokenMs: first && fetchAt ? first - fetchAt : null, toolStartMs: firstTool ? firstTool - t0 : null, totalMs: Date.now() - t0, replyChars: String(res.reply || '').length, bodyFile: `body-${bodies}.json` });
          await wait(500);
        }
      }
      globalThis.fetch = realFetch;
      step('ttft', { rounds });
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
