// Shipped default: no model. Replies with a fixed sentence.
const { abortError } = require('./provider');

const NULL_TEXT = 'No model is set yet. Open settings to choose one.';

const NullProvider = {
  id: 'null',
  label: 'No model',
  capabilities: { tools: false, logprobs: false, reasoning: false },
  async status() { return { ready: false, detail: 'No model set' }; },
  async *chat({ signal } = {}) {
    const words = NULL_TEXT.split(/(?<= )/); // keep the trailing space on each word
    for (const text of words) {
      if (signal?.aborted) throw abortError();
      await new Promise(r => setTimeout(r, 15));
      if (signal?.aborted) throw abortError();
      yield { type: 'token', text };
    }
    yield { type: 'done' };
  },
};

module.exports = { NullProvider, NULL_TEXT };
