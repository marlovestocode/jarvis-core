// Test-only provider. Replays a script of chunks. { type:'hang' } waits until aborted.
// A chunk { type:'throw', message } throws. Each call to chat() takes the next script
// when `script` is an array of arrays (one per call); a flat array is reused every call.
function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

function createFakeProvider(script, { delayMs = 0, contextMax, tools = true, id = 'fake', label = 'Fake' } = {}) {
  const calls = [];
  const multi = Array.isArray(script[0]);
  return {
    id, label,
    capabilities: { tools, logprobs: true, reasoning: true },
    calls,
    async status() { return { ready: true, detail: 'fake', ...(contextMax ? { contextMax } : {}) }; },
    async *chat({ messages, tools: t, signal }) {
      const n = calls.length;
      calls.push({ messages: messages.map(m => ({ ...m })), tools: t });
      const chunks = multi ? (script[n] || script[script.length - 1]) : script;
      for (const c of chunks) {
        if (signal?.aborted) throw abortError();
        if (c.type === 'hang') {
          await new Promise((_, rej) => {
            if (signal.aborted) return rej(abortError());
            signal.addEventListener('abort', () => rej(abortError()), { once: true });
          });
        }
        if (c.type === 'throw') throw new Error(c.message || 'provider failed');
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        if (signal?.aborted) throw abortError();
        yield c;
      }
    },
  };
}

module.exports = { createFakeProvider };
