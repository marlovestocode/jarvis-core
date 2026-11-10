// Tool definitions + runner. Tool: { name, description, params: JSONSchema, async run(args, ctx) → string, timeoutMs? }
// names the model has made up in the past, mapped to the real tool
const ALIASES = { ytm_music: 'youtube_music', youtube: 'youtube_music', play_music: 'youtube_music', get_volume: 'media_status', set_volume: 'media_control', media: 'media_control', weather: 'get_weather', get_news: 'news_headlines', wikipedia: 'lookup_knowledge', search: 'lookup_knowledge', web_search: 'lookup_knowledge', time: 'get_time', system_stats: 'get_system_stats' };

function createToolRunner(tools, { timeoutMs = 10000 } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));

  function specs() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }

  async function run(name, args, ctx = {}) {
    const tool = byName.get(name) || byName.get(ALIASES[name]);
    if (!tool) return { ok: false, text: `Error: unknown tool ${name}. Tools that exist: ${[...byName.keys()].join(', ')}. Use one of those, or say you cannot do it.` };
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
