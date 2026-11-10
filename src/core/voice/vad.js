// Energy-based voice activity detection. No model.
// threshold = max(minLevel, noiseFloor × 3) × gain; noise floor = mean RMS of the first 300 ms.
// push() returns 'start' once speech is heard (60 ms over threshold), 'end' after silenceMs
// of quiet, 'max' when the capture reaches maxMs; otherwise 'none'.
const CALIBRATE_MS = 300;
const START_MS = 60;
const SURE_SPEECH = 0.08; // RMS no quiet room reaches: speech even before the floor is known

function rmsOf(pcm) {
  if (!pcm || !pcm.length) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; s += v * v; }
  return Math.sqrt(s / pcm.length);
}

function createVad({ silenceMs = 800, maxMs = 30000, minLevel = 0.02 } = {}) {
  let gain = 1;
  let elapsed, calibMs, calibSum, calibN, floor, speaking, voicedMs, quietMs, done;
  const api = { rms: 0 };

  function reset() {
    elapsed = 0; calibMs = 0; calibSum = 0; calibN = 0; floor = 0;
    speaking = false; voicedMs = 0; quietMs = 0; done = false;
    api.rms = 0;
  }

  function threshold() { return Math.max(minLevel, floor * 3) * gain; }

  function push(pcm, sampleRate) {
    const ms = (pcm.length / sampleRate) * 1000;
    const r = rmsOf(pcm);
    api.rms = r;
    if (done) return 'none';
    elapsed += ms;

    if (calibMs < CALIBRATE_MS) {
      // learn the room from the first 300 ms. Frames clearly louder than any room noise
      // (user already talking) are not learned and count as speech right away.
      calibMs += ms;
      if (r <= SURE_SPEECH * gain) {
        calibSum += r; calibN++; floor = calibSum / calibN;
        voicedMs = 0;
        if (elapsed >= maxMs) { done = true; return 'max'; }
        return 'none';
      }
    }

    const loud = r > threshold();
    if (!speaking) {
      voicedMs = loud ? voicedMs + ms : 0;
      if (voicedMs >= START_MS) { speaking = true; quietMs = 0; return 'start'; }
    } else {
      quietMs = loud ? 0 : quietMs + ms;
      if (quietMs >= silenceMs) { done = true; return 'end'; }
    }
    if (elapsed >= maxMs) { done = true; return 'max'; }
    return 'none';
  }

  api.push = push;
  api.setGain = m => { gain = m > 0 ? m : 1; };
  api.reset = reset;
  Object.defineProperty(api, 'heard', { get: () => speaking });
  reset();
  return api;
}

module.exports = { createVad, rmsOf };
