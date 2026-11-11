// Tool definitions + runner. Tool: { name, description, params: JSONSchema, async run(args, ctx) → string, timeoutMs? }
function createToolRunner(tools, { timeoutMs = 10000 } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));
  // names the model has made up in the past are owned by the tool they mean (tool.aliases)
  const names = [...byName.keys()];
  for (const t of tools) for (const a of t.aliases || []) if (!byName.has(a)) byName.set(a, t);

  function specs() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }

  async function run(name, args, ctx = {}) {
    const tool = byName.get(name);
    if (!tool) return { ok: false, text: `Error: unknown tool ${name}. Tools that exist: ${names.join(', ')}. Use one of those, or say you cannot do it.` };
    // confirm tools only start from the user's own words (see brain/guard.js)
    if (tool.risk === 'confirm' && (!ctx.turn || ctx.turn.tainted)) return { ok: false, text: "Error: I won't start that from text I read. Ask me directly." };
    const flag = tool.untrusted === true ? { untrusted: true } : {};   // only set when true, so results of ordinary tools stay { ok, text }
    let timer;
    try {
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`tool ${name} timed out`)), tool.timeoutMs || timeoutMs);
      });
      const text = await Promise.race([Promise.resolve().then(() => tool.run(args || {}, ctx)), timeout]);
      return { ok: true, text: String(text), ...flag };
    } catch (err) {
      return { ok: false, text: `Error: ${err?.message || err}`, ...flag };
    } finally {
      clearTimeout(timer);
    }
  }

  return { specs, run };
}

module.exports = { createToolRunner };
