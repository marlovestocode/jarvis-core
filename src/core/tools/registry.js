// Tool definitions + runner. Tool: { name, description, params: JSONSchema, async run(args, ctx) → string, timeoutMs? }
function createToolRunner(tools, { timeoutMs = 10000 } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));

  function specs() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }

  async function run(name, args, ctx = {}) {
    const tool = byName.get(name);
    if (!tool) return { ok: false, text: `Error: unknown tool ${name}` };
    let timer;
    try {
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`tool ${name} timed out`)), tool.timeoutMs || timeoutMs);
      });
      const text = await Promise.race([Promise.resolve().then(() => tool.run(args || {}, ctx)), timeout]);
      return { ok: true, text: String(text) };
    } catch (err) {
      return { ok: false, text: `Error: ${err?.message || err}` };
    } finally {
      clearTimeout(timer);
    }
  }

  return { specs, run };
}

module.exports = { createToolRunner };
