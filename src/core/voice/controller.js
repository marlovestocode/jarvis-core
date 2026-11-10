// Voice turn (spec §4): listen → VAD → STT → chat turn → TTS, with barge-in.
// engines.{stt,tts,wake} may be engine objects or functions returning the current engine.
const { createVad } = require('./vad');
const { speakable, createSentenceSplitter } = require('./speech-text');

const SPEAKING_GAIN = 3; // speaker echo must not cut TTS off (Review Focus 1)
const MAX_BUFFER_MS = 31000;
const RING_MS = 2500;          // while the wake word is on: the last 2.5 s of mic audio
const IDLE_MAX_MS = 8000;      // Whisper wake: longest idle utterance checked for "Jarvis"
const WAKE_PREFIX = /^\s*(?:(?:hey|ok|okay|hi|yo)[\s,]+)?jarvis\b[\s,.!?:;-]*/i;

function createVoiceController({ bus, orchestrator, engines, getConfig, getSessionId, setSessionId = () => {}, vadOptions }) {
  const vad = createVad(vadOptions);
  const pick = k => (typeof engines[k] === 'function' ? engines[k]() : engines[k]);
  let mode = 'idle';           // idle | listening | working | speaking
  let chunks = [];
  let chunkMs = 0;
  let rate = 16000;
  let op = null;               // AbortController for the running stt/tts step
  let turn = 0;                // bumps on cancel/listen so stale async steps stop
  const logged = new Set();
  let wakeOn = null;
  let ring = [], ringMs = 0;
  const idleVad = createVad({ silenceMs: 500, maxMs: IDLE_MAX_MS });
  let idleChunks = [], idleMs = 0, idleBusy = false;

  function setState(state, detail) { bus.emit('state', detail ? { state, detail } : { state }); }
  function logOnce(kind, err) {
    if (logged.has(kind)) return;
    logged.add(kind);
    bus.emit('log', { level: 'warn', text: `${kind} failed: ${err?.message || err}. Using text only.` });
  }
  function abortOp() { if (op) { op.abort(); op = null; } }

  function listen() {
    abortOp();
    if (orchestrator.busy) orchestrator.stop(); // talking over JARVIS ends the reply it is writing
    turn++;
    mode = 'listening';
    chunks = []; chunkMs = 0;
    vad.reset(); vad.setGain(1);
    setState('listening');
  }

  function cancel() {
    const was = mode;
    turn++;
    abortOp();
    if (was === 'working' && orchestrator.busy) orchestrator.stop();
    mode = 'idle';
    if (was !== 'idle') setState('idle');
  }

  function feed(pcm, sampleRate) {
    if (mode === 'idle' && wakeOn?.kind === 'listen') { idleFeed(pcm, sampleRate); return; }
    if (mode === 'idle' && wakeOn) {      // keep a short history so "Jarvis, <command>" in one breath is not lost
      ring.push(pcm); ringMs += pcm.length / sampleRate * 1000;
      while (ringMs > RING_MS && ring.length > 1) { const c = ring.shift(); ringMs -= c.length / sampleRate * 1000; }
      return;
    }
    if (mode !== 'listening' && mode !== 'speaking') return;
    const r = vad.push(pcm, sampleRate);
    bus.emit('level', { source: 'mic', rms: vad.rms });
    if (mode === 'speaking') {
      if (r === 'start') { // barge-in
        listen();
      }
      return;
    }
    rate = sampleRate;
    chunks.push(pcm);
    chunkMs += (pcm.length / sampleRate) * 1000;
    while (chunkMs > MAX_BUFFER_MS && chunks.length) { const c = chunks.shift(); chunkMs -= (c.length / sampleRate) * 1000; }
    if (r === 'end' || r === 'max') finishCapture(vad.heard);
  }

  function concat(list) {
    const n = list.reduce((s, c) => s + c.length, 0);
    const out = new Int16Array(n);
    let o = 0;
    for (const c of list) { out.set(c, o); o += c.length; }
    return out;
  }

  async function finishCapture(heard) {
    const my = ++turn;
    mode = 'working';
    if (!heard) { mode = 'idle'; setState('idle'); return; }
    const pcm = concat(chunks);
    chunks = []; chunkMs = 0;
    op = new AbortController();
    let text = '';
    try {
      text = String(await pick('stt').transcribe(pcm, rate, op.signal) || '').trim();
    } catch (err) {
      if (my !== turn) return;
      logOnce('Speech-to-text', err);
      mode = 'idle'; setState('idle');
      return;
    }
    if (my !== turn) return;
    await runText(text, my);
  }

  // Wake word heard by Whisper on the user's own mic: while idle, each short utterance is
  // transcribed; one that starts with "Jarvis" wakes, and the rest of it is the command.
  function idleFeed(pcm, sampleRate) {
    const r = idleVad.push(pcm, sampleRate);
    idleChunks.push(pcm); idleMs += pcm.length / sampleRate * 1000;
    while (idleMs > IDLE_MAX_MS + RING_MS && idleChunks.length > 1) { const c = idleChunks.shift(); idleMs -= c.length / sampleRate * 1000; }
    if (r !== 'end' && r !== 'max') return;
    const heard = idleVad.heard;
    const audio = concat(idleChunks);
    idleChunks = []; idleMs = 0; idleVad.reset();
    if (!heard || idleBusy) return;
    idleBusy = true;
    pick('stt').transcribe(audio, sampleRate).then(async t => {
      idleBusy = false;
      const said = String(t || '').trim();
      if (mode !== 'idle' || !WAKE_PREFIX.test(said)) return;   // not for JARVIS: forget it
      bus.emit('wake', { text: said });
      const my = ++turn;
      mode = 'working';
      rate = sampleRate;
      await runText(said, my);
    }, () => { idleBusy = false; });
  }

  async function runText(text, my) {
    const said = text;
    text = text.replace(WAKE_PREFIX, '').trim();
    if (!text && WAKE_PREFIX.test(said)) { listen(); return; }   // just "Jarvis": wait for the command
    if (!text) { mode = 'idle'; setState('idle'); return; }

    // Streaming speech: engines with createStream speak each sentence as soon as the model
    // finishes writing it, instead of waiting for the whole reply.
    const tts = pick('tts');
    const streaming = typeof tts?.createStream === 'function';
    let stream = null, offTok = null, splitter = null;
    const feedText = s => {
      const t = speakable(s);
      if (!t || my !== turn) return;
      if (!stream) {
        op = new AbortController();
        try { stream = tts.createStream({ rate: getConfig().voiceRate, signal: op.signal }); } catch (err) { logOnce('Text-to-speech', err); return; }
        beginSpeaking(stream, op.signal);
      }
      stream.push(t);
    };
    if (streaming) {
      splitter = createSentenceSplitter();
      offTok = bus.on('token', ev => { if (my === turn) for (const s of splitter.push(ev.text)) feedText(s); });
    }

    let res;
    try {
      res = await orchestrator.send(getSessionId(), text, { source: 'voice' });
    } catch (err) {
      offTok?.();
      if (my !== turn) return;
      mode = 'idle';
      if (err?.message === 'BUSY') {
        bus.emit('log', { level: 'warn', text: `Heard "${text}" while a reply was still running; say it again when it finishes.` });
        setState('idle', 'Busy: say it again when the reply finishes');
      } else {
        bus.emit('log', { level: 'warn', text: `Voice turn failed: ${err?.message || err}` });
        setState('idle');
      }
      return;
    }
    offTok?.();
    if (res?.sessionId) setSessionId(res.sessionId);
    if (my !== turn) return;
    if (res.error || res.stopped || !res.reply || !res.reply.trim()) {
      if (stream) abortOp();
      mode = 'idle';
      if (!res.error && !res.stopped) setState('idle'); // the orchestrator already ended error/stop turns
      return;
    }
    if (!streaming) { await speak(res.reply, my); return; }
    for (const s of splitter.flush()) feedText(s);
    if (!stream) { mode = 'idle'; setState('idle'); return; }
    stream.end();
    try { await stream.done; } catch (err) { if (!op?.signal.aborted) logOnce('Text-to-speech', err); }
    if (my === turn && mode === 'speaking') { mode = 'idle'; op = null; setState('idle'); }
  }

  // Speech is starting: raise the barge-in threshold (echo) and show real voice levels.
  function beginSpeaking(handle, signal) {
    mode = 'speaking';
    vad.reset(); vad.setGain(SPEAKING_GAIN);
    setState('speaking');
    (async () => {
      try { for await (const v of handle.levels || []) { if (signal.aborted) break; bus.emit('level', { source: 'tts', rms: v }); } } catch { /* cosmetic */ }
    })();
  }

  async function speak(text, my) {
    mode = 'speaking';
    vad.reset(); vad.setGain(SPEAKING_GAIN);
    op = new AbortController();
    const signal = op.signal;
    let handle;
    try {
      handle = pick('tts').speak(text, { rate: getConfig().voiceRate, signal });
    } catch (err) {
      logOnce('Text-to-speech', err);
      if (my === turn) { mode = 'idle'; setState('idle'); }
      return;
    }
    setState('speaking');
    let finished = false;
    (async () => {
      try {
        for await (const v of handle.levels || []) {
          if (finished || signal.aborted) break;
          bus.emit('level', { source: 'tts', rms: v });
        }
      } catch { /* levels are cosmetic */ }
    })();
    try {
      await handle.done;
    } catch (err) {
      if (!signal.aborted) logOnce('Text-to-speech', err);
    }
    finished = true;
    if (my === turn && mode === 'speaking') { mode = 'idle'; op = null; setState('idle'); }
  }

  // Start or stop the wake word engine to match config.wakeEnabled.
  function applyWake() {
    const want = !!getConfig().wakeEnabled;
    const engine = pick('wake');
    if (wakeOn && (!want || wakeOn !== engine)) { try { wakeOn.stop?.(); } catch { /* ignore */ } wakeOn = null; }
    if (want && engine?.kind === 'listen' && !wakeOn) {   // Whisper wake: our own mic, handled in idleFeed
      wakeOn = engine; idleVad.reset(); idleChunks = []; idleMs = 0;
      return;
    }
    if (want && engine && !wakeOn) {
      try {
        engine.start(() => {
          // while speaking, our own TTS can say "Jarvis": barge-in is the VAD's job (×3 gain)
          if (mode !== 'idle') return;
          bus.emit('wake', {});
          const pre = ring; ring = []; ringMs = 0;
          listen();
          for (const c of pre) feed(c, 16000);   // start the capture from just before the wake word
        });
        wakeOn = engine;
      } catch (err) { logOnce('Wake word', err); }
    }
  }

  return {
    listen, feed, cancel, applyWake,
    get speaking() { return mode === 'speaking'; },
    get active() { return mode !== 'idle'; },
    get mode() { return mode; },
  };
}

module.exports = { createVoiceController, SPEAKING_GAIN };
