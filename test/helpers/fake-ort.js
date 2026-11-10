// Fake onnxruntime for Silero tests: Tensor records its args; the session replays scripted
// probabilities (one per 512-sample frame) and returns a state that counts runs.
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
function fakeOrt({ probs = [], inputNames = ['input', 'state', 'sr'], outputNames = ['output', 'stateN'], fail } = {}) {
  const calls = [];
  const session = {
    inputNames, outputNames,
    async run(feeds) {
      calls.push(feeds);
      if (fail && calls.length >= fail) throw new Error('boom');
      const p = typeof probs === 'function' ? probs(calls.length - 1) : probs[calls.length - 1] ?? 0;
      return { [outputNames[0]]: new Tensor('float32', Float32Array.of(p), [1, 1]), [outputNames[1]]: new Tensor('float32', new Float32Array(256).fill(calls.length), [2, 1, 128]) };
    },
  };
  const created = [];
  return { ort: { Tensor, InferenceSession: { create: async (p, o) => { created.push(o); return session; } } }, calls, session, created };
}
module.exports = { Tensor, fakeOrt };
