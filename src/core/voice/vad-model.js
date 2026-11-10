// Model-backed VAD (Silero) with the same interface as createVad: push, reset, setGain, heard, rms.
// Inference is async but push() stays sync: probabilities resolve in a serial queue, the state
// machine below consumes them, and any 'start' | 'end' | 'max' is latched and returned by the
// next push() (≤ one 20 ms mic frame after the 32 ms Silero frame resolves, ~50 ms in practice).
// An energy VAD always runs alongside: it feeds rms (level meter) and takes over when there is no
// model (getModel() is read at reset, so a config switch applies to the next capture) or the model fails.
const { createVad } = require('./vad');
const { createSileroStream, FRAME_MS } = require('./silero');

const START_P = 0.5, START_FRAMES = 3;          // 96 ms of speech
const SPEAK_START_P = 0.8, SPEAK_START_FRAMES = 5; // speaking mode (gain > 1): ignore JARVIS's own echo
const END_P = 0.35;                              // hysteresis: 0.35..0.5 neither starts nor ends speech

function createModelVad({ getModel = () => null, silenceMs = 800, maxMs = 30000, minLevel, onError = () => {} } = {}) {
  const energy = createVad({ silenceMs, maxMs, minLevel });
  let gain = 1, failed = false, model = null, stream = null, streamOf = null;
  let events, speaking, run, quietMs, done, elapsed;
  const api = { rms: 0 };

  function onProb(p) {
    if (done) return;
    if (!speaking) {
      const [thr, need] = gain > 1 ? [SPEAK_START_P, SPEAK_START_FRAMES] : [START_P, START_FRAMES];
      run = p > thr ? run + 1 : 0;
      if (run >= need) { speaking = true; quietMs = 0; events.push('start'); }
    } else {
      quietMs = p < END_P ? quietMs + FRAME_MS : 0;
      if (quietMs >= silenceMs) { done = true; events.push('end'); }
    }
  }

  function fail(err) {
    if (failed) return;
    failed = true;
    onError(err);
    if (!done) { done = true; events.push(speaking ? 'end' : 'max'); }   // hand what was heard to STT
  }

  function reset() {
    energy.reset();
    api.rms = 0;
    events = []; speaking = false; run = 0; quietMs = 0; done = false; elapsed = 0;
    model = failed ? null : getModel() || null;
    if (model && streamOf !== model) { stream = createSileroStream(model, { onProb: p => onProb(p), onError: fail }); streamOf = model; }
    else if (model) stream.reset();
  }

  function push(pcm, sampleRate) {
    const r = energy.push(pcm, sampleRate);
    api.rms = energy.rms;
    if (!model) return r;
    elapsed += pcm.length / sampleRate * 1000;
    if (!done) stream.push(pcm, sampleRate);
    if (events.length) return events.shift();
    if (!done && elapsed >= maxMs) { done = true; return 'max'; }
    return 'none';
  }

  api.push = push;
  api.reset = reset;
  api.setGain = g => { gain = g > 0 ? g : 1; energy.setGain(g); };
  api.idle = () => (model ? stream.idle() : Promise.resolve());   // tests and the bench: wait for queued frames
  Object.defineProperty(api, 'heard', { get: () => (model ? speaking : energy.heard) });
  reset();
  return api;
}

module.exports = { createModelVad };
