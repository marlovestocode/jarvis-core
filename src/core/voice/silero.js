// Silero VAD v5 on onnxruntime. One shared session per model file; each stream owns its own
// RNN state and audio context, so the three controller VADs never share history.
// Signature checked against silero_vad.onnx v5.1.2 and upstream OnnxWrapper (utils_vad.py):
//   in:  input float32 [1, 64 + 512] (64 samples of context + 32 ms frame), state float32 [2, 1, 128], sr int64 []
//   out: output float32 [1, 1] speech probability, stateN float32 [2, 1, 128]
const RATE = 16000;
const FRAME = 512;
const CONTEXT = 64;

async function loadSilero({ modelPath, ort }) {
  // one thread: the default pool uses every core and spin-waits between runs, measured ~197% of a core
  // for a real-time 32 ms frame stream vs 0.8% single-threaded; the model is tiny, one thread is plenty
  const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' });
  const ins = session.inputNames, outs = session.outputNames;
  if (!['input', 'state', 'sr'].every(n => ins.includes(n)) || outs.length < 2) {
    throw new Error(`unsupported Silero model signature: in [${ins}] out [${outs}] (need v5: input, state, sr)`);
  }
  const names = { input: 'input', state: 'state', sr: 'sr', output: outs.includes('output') ? 'output' : outs[0], stateN: outs.includes('stateN') ? 'stateN' : outs[1] };
  let chain = Promise.resolve();   // runs are serialized across streams: one session, one at a time
  const run = feeds => { const p = chain.then(() => session.run(feeds)); chain = p.catch(() => {}); return p; };
  return { ort, names, run };
}

// push(int16, rate) queues 512-sample frames (remainder carried); onProb(p) fires per frame in order.
function createSileroStream(model, { onProb = () => {}, onError = () => {} } = {}) {
  const { ort, names } = model;
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
  let state, context, pending, pendingN, gen = 0, chain = Promise.resolve();

  function reset() {
    gen++;
    state = new Float32Array(2 * 128);
    context = new Float32Array(CONTEXT);
    pending = new Float32Array(FRAME); pendingN = 0;
  }

  function runFrame(frame, my) {
    chain = chain.then(async () => {
      if (my !== gen) return;
      const input = new Float32Array(CONTEXT + FRAME);
      input.set(context); input.set(frame, CONTEXT);
      context = frame.slice(FRAME - CONTEXT);
      const out = await model.run({
        [names.input]: new ort.Tensor('float32', input, [1, CONTEXT + FRAME]),
        [names.state]: new ort.Tensor('float32', state, [2, 1, 128]),
        [names.sr]: sr,
      });
      if (my !== gen) return;   // reset while this frame ran: its result belongs to old audio
      state = Float32Array.from(out[names.stateN].data);
      onProb(out[names.output].data[0]);
    }).catch(err => { if (my === gen) onError(err); });
  }

  function push(pcm, rate) {
    if (rate !== RATE) { onError(new Error(`Silero VAD needs ${RATE} Hz audio, got ${rate}`)); return; }
    for (let i = 0; i < pcm.length; i++) {
      pending[pendingN++] = pcm[i] / 32768;
      if (pendingN === FRAME) { runFrame(pending, gen); pending = new Float32Array(FRAME); pendingN = 0; }
    }
  }

  reset();
  return { push, reset, idle: () => chain };
}

module.exports = { loadSilero, createSileroStream, FRAME_MS: FRAME / RATE * 1000 };
