// Voice turn (spec §4): listen → VAD → STT → chat turn → TTS.
// While speaking (spec §7a) only "Jarvis, …" interrupts: "Jarvis, stop" stops at once, "Jarvis, <request>"
// lets the current sentence finish and then handles the request; anything else (other people, games,
// JARVIS's own echo) is ignored. Loudness alone never interrupts.
// engines.{stt,tts,wake} may be engine objects or functions returning the current engine.
const { createVad } = require('./vad');
const { createTrace } = require('./trace');
const { isYes } = require('../brain/guard');
const { speakable, createSentenceSplitter } = require('./speech-text');

const SPEAKING_GAIN = 3; // speaker echo is mostly under the ×3 threshold, so Whisper is not run on it
const MAX_BUFFER_MS = 31000;
const RING_MS = 2500;          // while the wake word is on: the last 2.5 s of mic audio
const IDLE_MAX_MS = 8000;      // Whisper wake: longest idle utterance checked for "Jarvis"
const WAKE_PREFIX = /^\s*(?:(?:hey|ok|okay|hi|yo)[\s,]+)?jarvis\b[\s,.!?:;-]*/i;
const STOP_WORDS = /^(?:stop|quiet|enough|cancel|shut up|that'?s enough|be quiet|never ?mind)\b/i;
const SPEAK_MAX_MS = 3000;     // while speaking, audio is checked in 3 s windows: JARVIS's own echo keeps an
const SPEAK_OVERLAP_MS = 1000; // "utterance" open, so waiting for silence delayed a wake by up to 8 s; 1 s overlap keeps a split "Jarvis"
// While speaking the wake word can be anywhere: the echo of JARVIS's reply comes first in the transcript.
// Speaking-only, because only speech is stopped: also the mishearings Whisper gave over echo ("Javas", "Java's").
const WAKE_ANY = /\b(?:(?:hey|ok|okay|hi|yo)[\s,]+)?(?:jarvis|jarvas|jervis|javis|javas|javus|java's)\b[\s,.!?:;-]*/gi;

// A speech-to-text call that never answers must not hold the controller. Whisper splits audio into 14 s chunks, so the
// 31 s capture is 3 inferences (~0.1-0.3 s each); the rest is a cold server start (30 s) and a possible CPU restart.
const STT_CAPTURE_TIMEOUT_MS = 60000;
const STT_WAKE_TIMEOUT_MS = 30000;   // idle (≤ 8 s) and speaking (≤ 3 s) windows are one inference each

const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Continuation guard: a turn that ends on one of these words was probably cut by a pause, not finished.
// Whisper usually adds a period anyway ("Remind me to call my."), so a trailing "."/"…" does not count
// as finished; "?" and "!" do.
const DANGLING = new Set(['and', 'but', 'or', 'so', 'because', 'then', 'the', 'a', 'an', 'to', 'of', 'with', 'for', 'like', 'um', 'uh', 'my', 'your', 'that', 'if']);
const CONT_MAX_EXT = 2, CONT_MAX_MS = 20000;
function dangling(text) {
  const t = String(text || '').trim();
  if (!t || /[?!]$/.test(t)) return false;
  return DANGLING.has(norm(t).split(' ').pop());
}

function createVoiceController({ bus, orchestrator, engines, getConfig, getSessionId, setSessionId = () => {}, vadOptions, vadFactory = createVad, writeTrace = () => {}, continuationMs = 1500, speaker = null, confirmPending = () => false }) {
  const vad = vadFactory(vadOptions);
  const trace = createTrace();   // per-turn timing; summary goes to the log + writeTrace at turn end
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
  const idleVad = vadFactory({ silenceMs: 500, maxMs: IDLE_MAX_MS });
  let idleChunks = [], idleMs = 0, idleBusy = false;
  const speakVad = vadFactory({ silenceMs: 500, maxMs: SPEAK_MAX_MS });
  let spChunks = [], spMs = 0, spBusy = false;
  let stripWake = false;       // the current capture began with a spoken interrupt
  let ext = 0, held = null, contTimer = null, during = null, duringMs = 0;   // continuation guard: extensions, first transcript, wait timer, frames heard while transcribing
  let current = null;          // the TTS stream/handle now speaking
  let spoken = '';             // what JARVIS has said this turn (echo check)
  let lastSend = Promise.resolve();

  function setState(state, detail) {
    if (state === 'idle') endTrace();
    bus.emit('state', detail ? { state, detail } : { state });
  }
  function endTrace() {
    if (trace.empty) return;
    trace.mark('turn_end');
    const sum = trace.summary();
    trace.reset();
    if (sum.marks.first_audio === undefined) return;   // no audio was produced: nothing to time
    bus.emit('log', { level: 'debug', text: 'voice-timing ' + JSON.stringify(sum) });
    try { writeTrace(sum); } catch { /* tracing must never break a turn */ }
  }
  function logOnce(kind, err) {
    if (logged.has(kind)) return;
    logged.add(kind);
    bus.emit('log', { level: 'warn', text: `${kind} failed: ${err?.message || err}. Using text only.` });
  }
  function logHung(kind, err) {
    if (logged.has(kind)) return;
    logged.add(kind);
    bus.emit('log', { level: 'warn', text: `${kind}: speech-to-text ${err.message}; listening again.` });
  }
  function abortOp() { if (op) { op.abort(); op = null; } }
  // transcribe(), but gives up after `ms`: aborts the call (engines that take a signal stop) and rejects.
  function transcribeWithin(audio, sampleRate, ms, ac) {
    let timer;
    const hung = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error(`timed out after ${ms / 1000} s`), { timedOut: true })); }, ms); });
    ac.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });   // cancel(): nothing left to time
    const call = (async () => pick('stt').transcribe(audio, sampleRate, ac.signal))();
    return Promise.race([call, hung]).finally(() => clearTimeout(timer));
  }

  function listen() {
    stripWake = false;
    ext = 0; held = null; during = null; clearTimeout(contTimer);
    abortOp();
    if (orchestrator.busy) orchestrator.stop(); // talking over JARVIS ends the reply it is writing
    turn++;
    trace.reset();
    mode = 'listening';
    chunks = []; chunkMs = 0;
    vad.reset(); vad.setGain(1);
    setState('listening');
  }

  function cancel() {
    const was = mode;
    held = null; during = null; clearTimeout(contTimer);
    turn++;
    abortOp();
    if ((was === 'working' || was === 'speaking') && orchestrator.busy) orchestrator.stop();
    current = null;
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
    if (mode === 'speaking') { speakingFeed(pcm, sampleRate); return; }
    if (mode === 'working' && during) {   // speech that goes on while the guard's transcript is pending
      during.push(pcm); duringMs += pcm.length / sampleRate * 1000;
      // same cap as the capture: a speech-to-text call that never answers must not hold the mic stream for ever
      while (duringMs > MAX_BUFFER_MS && during.length > 1) { const c = during.shift(); duringMs -= c.length / sampleRate * 1000; }
      return;
    }
    if (mode !== 'listening') return;
    const r = vad.push(pcm, sampleRate);
    if (r === 'start') trace.mark('speech_start');
    if (r === 'end' || r === 'max') trace.mark('speech_end');
    bus.emit('level', { source: 'mic', rms: vad.rms });
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
  function lastMs(list, ms, sampleRate) {   // the frames covering the last `ms` of a chunk list
    const out = [];
    for (let i = list.length - 1, t = 0; i >= 0 && t < ms; i--) { out.unshift(list[i]); t += list[i].length / sampleRate * 1000; }
    return out;
  }

  // Only the enrolled voice may wake JARVIS (config.speakerGate, and only once a voice is enrolled).
  // The hotkey is never gated: pressing it is already the user. A broken model never blocks (verify fails open).
  async function speakerOk(audio, sampleRate, lenient, strict = false) {
    if (!speaker || !getConfig().speakerGate || !speaker.enrolled()) return true;
    const r = await speaker.verify(audio, sampleRate, { lenient, strict });
    if (r.ok) return true;
    bus.emit('log', { level: 'info', text: strict ? `Ignored a spoken yes from a voice that is not yours (${r.reason || 'match ' + r.score})` : `Ignored "Jarvis" from a voice that is not yours (match ${r.score}, needs ${r.threshold})` });
    bus.emit('speaker', { ok: false, score: r.score });
    return false;
  }

  // A risky action waits for a yes: when it comes by voice, only the enrolled voice may give it (strict: no pass on errors).
  // Without an enrolled voice there is nothing to check against; the answer still has to be a plain yes within 60 s.
  async function yesOk(text, audio, sampleRate) {
    if (!confirmPending() || !isYes(text)) return true;
    return speakerOk(audio, sampleRate, false, true);
  }

  async function finishCapture(heard) {
    const my = ++turn;
    mode = 'working';
    if (!heard) { mode = 'idle'; setState('idle'); return; }
    const parts = chunks, partsMs = chunkMs;
    const pcm = concat(chunks);
    chunks = []; chunkMs = 0;
    if (getConfig().continuationGuard) { during = []; duringMs = 0; }
    op = new AbortController();
    let text = '';
    try {
      text = String(await transcribeWithin(pcm, rate, STT_CAPTURE_TIMEOUT_MS, op) || '').trim();
    } catch (err) {
      if (my !== turn) return;
      logOnce('Speech-to-text', err);
      mode = 'idle'; setState('idle');
      return;
    }
    if (my !== turn) return;
    trace.mark('stt_done');
    if (getConfig().continuationGuard && ext < CONT_MAX_EXT && partsMs < CONT_MAX_MS && dangling(text)) {
      extend(parts, partsMs, text);
      return;
    }
    during = null; held = null;
    if (stripWake) {                   // capture opened by a spoken interrupt: keep only what follows the wake word
      stripWake = false;
      const hits = [...text.matchAll(WAKE_ANY)];
      if (hits.length) { const h = hits.at(-1); text = text.slice(h.index + h[0].length).trim(); }
      if (STOP_WORDS.test(text)) { mode = 'idle'; setState('idle'); return; }
    }
    if (!(await yesOk(text, pcm, rate))) { if (my === turn) { mode = 'idle'; setState('idle'); } return; }
    await runText(text, my);
  }

  // Reopen the capture (audio kept) for up to continuationMs. New speech → the whole audio is transcribed
  // again when it ends; none → the transcript we already have is used, without running Whisper again.
  function extend(parts, partsMs, text) {
    ext++; held = text;
    const late = during || []; during = null;
    chunks = parts; chunkMs = partsMs;
    mode = 'listening';
    vad.reset(); vad.setGain(1);
    bus.emit('state', { state: 'listening' });
    const my = turn;
    clearTimeout(contTimer);
    contTimer = setTimeout(() => {
      if (my !== turn || mode !== 'listening' || vad.heard || held === null) return;
      const t = held; held = null;
      const now = ++turn;
      mode = 'working';
      yesOk(t, concat(parts), rate).then(ok => { if (ok) return runText(t, now); if (now === turn) { mode = 'idle'; setState('idle'); } });
    }, continuationMs);
    for (const c of late) feed(c, rate);
  }

  // Wake word heard by Whisper on the user's own mic: while idle, each short utterance is
  // transcribed; one that starts with "Jarvis" wakes, and the rest of it is the command.
  function idleFeed(pcm, sampleRate) {
    const r = idleVad.push(pcm, sampleRate);
    idleChunks.push(pcm); idleMs += pcm.length / sampleRate * 1000;
    while (idleMs > IDLE_MAX_MS + RING_MS && idleChunks.length > 1) { const c = idleChunks.shift(); idleMs -= c.length / sampleRate * 1000; }
    if (r !== 'end' && r !== 'max') return;
    const heard = idleVad.heard;
    const endedAt = trace.now();
    const audio = concat(idleChunks);
    idleChunks = []; idleMs = 0; idleVad.reset();
    if (!heard || idleBusy) return;
    idleBusy = true;
    transcribeWithin(audio, sampleRate, STT_WAKE_TIMEOUT_MS, new AbortController()).then(async t => {
      idleBusy = false;
      const said = String(t || '').trim();
      if (mode !== 'idle' || !WAKE_PREFIX.test(said)) return;   // not for JARVIS: forget it
      if (!(await speakerOk(audio, sampleRate, false)) || mode !== 'idle') return;   // someone else said it
      bus.emit('wake', { text: said });
      trace.reset(); trace.mark('speech_end', endedAt); trace.mark('wake_heard'); trace.mark('stt_done');
      const my = ++turn;
      mode = 'working';
      rate = sampleRate;
      await runText(said, my);
    }, err => { idleBusy = false; if (err.timedOut) logHung('Wake word listening', err); });
  }

  // While speaking: each utterance over the ×3 threshold is transcribed; only "Jarvis, …" counts.
  function speakingFeed(pcm, sampleRate) {
    const r = speakVad.push(pcm, sampleRate);
    bus.emit('level', { source: 'mic', rms: speakVad.rms });
    spChunks.push(pcm); spMs += pcm.length / sampleRate * 1000;
    while (spMs > SPEAK_MAX_MS + RING_MS && spChunks.length > 1) { const c = spChunks.shift(); spMs -= c.length / sampleRate * 1000; }
    if (r !== 'end' && r !== 'max') return;
    const heard = speakVad.heard;
    const audio = concat(spChunks);
    const tail = r === 'max' ? lastMs(spChunks, SPEAK_OVERLAP_MS, sampleRate) : [];
    resetSpeaking();
    for (const c of tail) { spChunks.push(c); spMs += c.length / sampleRate * 1000; }   // a window cut mid-"Jarvis" is seen whole next time
    if (!heard || spBusy) return;
    spBusy = true;
    const cut = r === 'max';   // the window closed while sound went on: the phrase may be split
    transcribeWithin(audio, sampleRate, STT_WAKE_TIMEOUT_MS, new AbortController()).then(async t => {
      const said = String(t || '').trim();
      // JARVIS's own voice is mixed into this audio, so the bar is a little lower than for the idle wake
      if (speaker && [...said.matchAll(WAKE_ANY)].length && !(await speakerOk(audio, sampleRate, true))) { spBusy = false; return; }
      spBusy = false; onSpeakingUtterance(said, cut);
    }, err => { spBusy = false; if (err.timedOut) logHung('Interrupt listening', err); });
  }
  function resetSpeaking() { spChunks = []; spMs = 0; speakVad.reset(); speakVad.setGain(SPEAKING_GAIN); }
  // After a "Jarvis", the rest of the transcript may be more echo: keep it only if most of its words
  // are not JARVIS's own (else '' → just listen). Stop words are checked before this.
  function dropEcho(rest, own) {
    if (STOP_WORDS.test(rest)) return rest;
    const words = norm(rest).split(' ').filter(Boolean);
    const mine = new Set(own.split(' '));
    return words.filter(w => !mine.has(w)).length * 2 >= words.length ? rest : '';
  }

  function onSpeakingUtterance(said, cut = false) {
    if (mode !== 'speaking') return;
    const n = norm(said), own = norm(spoken);
    if (!n || own.includes(n)) return;                              // its own voice through the speakers
    const hits = [...said.matchAll(WAKE_ANY)];
    const ownWakes = (own.match(/\bjarvis\b/g) || []).length;       // JARVIS saying "Jarvis" is echo, not a wake
    if (hits.length <= ownWakes) return;                            // not for JARVIS: keep speaking
    const hit = hits[ownWakes];
    const rest = dropEcho(said.slice(hit.index + hit[0].length).trim(), own);
    bus.emit('wake', { text: said });
    if (STOP_WORDS.test(rest)) {                                    // "Jarvis, stop": now, mid-word
      bus.emit('log', { level: 'info', text: 'Stopped by voice: "' + said + '"' });
      cancel();
      return;
    }
    if (getConfig().wakeInterrupt === 'sentence') { softInterrupt(rest); return; }   // old: finish the sentence first
    if (rest && !cut) { interruptNow(rest); return; }
    interruptListen();
  }

  // "Jarvis, <command>" heard whole while speaking: cut the speech and run the command.
  async function interruptNow(rest) {
    const my = ++turn;
    abortOp();
    if (orchestrator.busy) orchestrator.stop();
    current = null;
    mode = 'working';
    await lastSend;                    // let the stopped reply settle before the next turn
    if (my !== turn) return;
    await runText(rest, my);
  }
  // "Jarvis" heard but the command is missing or was cut by the window: stop speaking, listen, and replay
  // the audio held since the window (≥ 1 s overlap) so the words already said are transcribed whole,
  // now without JARVIS talking over them. The wake word is stripped from that transcript.
  function interruptListen() {
    const held = spChunks;
    resetSpeaking();
    current = null;
    listen();
    stripWake = true;
    for (const c of held) feed(c, rate);
  }

  // "Jarvis, <request>": the model stops writing, the sentence being spoken ends, then the request runs.
  async function softInterrupt(rest) {
    const my = ++turn;                 // the old turn's async steps stand down
    if (orchestrator.busy) orchestrator.stop();
    const handle = current;
    try {
      if (typeof handle?.finishSentence === 'function') await handle.finishSentence();
      else abortOp();                  // an engine without sentence control: stop now
    } catch { /* ended anyway */ }
    if (my !== turn) return;           // "Jarvis, stop" while the sentence was ending
    op = null; current = null;
    await lastSend;                    // let the stopped reply settle before the next turn
    if (my !== turn) return;
    if (!rest) { listen(); return; }
    mode = 'working';
    await runText(rest, my);
  }

  async function runText(text, my) {
    const said = text;
    text = text.replace(WAKE_PREFIX, '').trim();
    if (!text && WAKE_PREFIX.test(said)) { listen(); return; }   // just "Jarvis": wait for the command
    if (!text) { mode = 'idle'; setState('idle'); return; }

    // Streaming speech: engines with createStream speak each sentence as soon as the model
    // finishes writing it, instead of waiting for the whole reply.
    spoken = '';
    const tts = pick('tts');
    const streaming = typeof tts?.createStream === 'function';
    let stream = null, offTok = null, splitter = null;
    const offTrace = bus.on('token', () => { if (my === turn) trace.mark('first_token'); });  // timing only; works for non-streaming TTS too
    const feedText = s => {
      const t = speakable(s);
      if (!t || my !== turn) return;
      if (!stream) {
        op = new AbortController();
        try { stream = tts.createStream({ rate: getConfig().voiceRate, signal: op.signal }); } catch (err) { logOnce('Text-to-speech', err); return; }
        beginSpeaking(stream, op.signal);
      }
      spoken += ' ' + t;
      stream.push(t);
    };
    if (streaming) {
      splitter = createSentenceSplitter();
      offTok = bus.on('token', ev => { if (my === turn) for (const s of splitter.push(ev.text)) feedText(s); });
    }

    let res;
    try {
      const sending = orchestrator.send(getSessionId(), text, { source: 'voice' });
      lastSend = sending.then(() => {}, () => {});
      res = await sending;
    } catch (err) {
      offTok?.(); offTrace();
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
    offTok?.(); offTrace();
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

  // Speech is starting: listen for "Jarvis" over the echo and show real voice levels.
  function beginSpeaking(handle, signal) {
    mode = 'speaking';
    trace.mark('first_audio');
    current = handle;
    resetSpeaking();
    setState('speaking');
    (async () => {
      try { for await (const v of handle.levels || []) { if (signal.aborted) break; bus.emit('level', { source: 'tts', rms: v }); } } catch { /* cosmetic */ }
    })();
  }

  // → true when the speech played to the end; false when TTS failed or was cut (barge-in, cancel)
  async function speak(text, my) {
    mode = 'speaking';
    resetSpeaking();
    spoken = ' ' + text;
    op = new AbortController();
    const signal = op.signal;
    let handle;
    try {
      handle = pick('tts').speak(text, { rate: getConfig().voiceRate, signal });
    } catch (err) {
      logOnce('Text-to-speech', err);
      if (my === turn) { mode = 'idle'; setState('idle'); }
      return false;
    }
    current = handle;
    trace.mark('first_audio');
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
    let failed = false;
    try {
      await handle.done;
    } catch (err) {
      failed = true;
      if (!signal.aborted) logOnce('Text-to-speech', err);
    }
    finished = true;
    if (my === turn && mode === 'speaking') { mode = 'idle'; op = null; setState('idle'); }
    return !failed && !signal.aborted && my === turn;
  }

  // Proactive speech (timers): only when idle, through the normal speaking path so "Jarvis, stop"
  // and Esc cut it like any reply. → true only when it was spoken to the end.
  async function announce(text) {
    if (mode !== 'idle' || !String(text || '').trim()) return false;
    turn++;
    trace.reset();
    return speak(String(text), turn);
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
          // while speaking, our own TTS can say "Jarvis": interrupts are the speaking detector's job
          if (mode !== 'idle') return;
          bus.emit('wake', {});
          const pre = ring; ring = []; ringMs = 0;
          listen();
          trace.mark('wake_heard');
          for (const c of pre) feed(c, 16000);   // start the capture from just before the wake word
        });
        wakeOn = engine;
      } catch (err) { logOnce('Wake word', err); }
    }
  }

  return {
    listen, feed, cancel, applyWake, announce,
    get speaking() { return mode === 'speaking'; },
    get active() { return mode !== 'idle'; },
    get mode() { return mode; },
    stats: () => ({ captureMs: Math.round(chunkMs), pendingMs: during ? Math.round(duringMs) : 0, capMs: MAX_BUFFER_MS }),
  };
}

module.exports = { createVoiceController, SPEAKING_GAIN, STOP_WORDS, WAKE_PREFIX };
