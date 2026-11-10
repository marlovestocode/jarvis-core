// ModelProvider interface (spec §3) and a generic id → item registry.
//
// Provider shape:
//   { id, label, capabilities: { tools, logprobs, reasoning },
//     async status() → { ready, detail, contextMax? },
//     async *chat({ messages, tools, signal }) → yields
//       { type:'token', text, prob?, alts? } | { type:'reasoning', text }
//       | { type:'tool_call', id, name, args } | { type:'done', usage? } }
// chat() must stop promptly (throw AbortError) when signal aborts.

function createRegistry() {
  const items = new Map();
  return {
    add(item) {
      if (!item || typeof item.id !== 'string') throw new Error('registry item needs an id');
      items.set(item.id, item);
      return item;
    },
    get(id) { return items.get(id); },
    list() { return [...items.values()].map(({ id, label }) => ({ id, label })); },
  };
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

module.exports = { createRegistry, abortError };
