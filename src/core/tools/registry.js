// Tool definitions + runner. Tool: { name, description, params: JSONSchema, async run(args, ctx) → string, timeoutMs? }
// names the model has made up in the past, mapped to the real tool
const ALIASES = { ytm_music: 'youtube_music', youtube: 'youtube_music', play_music: 'youtube_music', get_volume: 'media_status', set_volume: 'media_control', media: 'media_control', weather: 'get_weather', get_news: 'news_headlines', wikipedia: 'lookup_knowledge', search: 'lookup_knowledge', web_search: 'lookup_knowledge', time: 'get_time', system_stats: 'get_system_stats',
  timer: 'set_timer', start_timer: 'set_timer', create_timer: 'set_timer', alarm: 'set_alarm', create_alarm: 'set_alarm', remind_me: 'set_reminder', reminder: 'set_reminder', create_reminder: 'set_reminder', get_timers: 'list_timers', delete_timer: 'cancel_timer', stop_timer: 'cancel_timer', cancel_alarm: 'cancel_timer', cancel_reminder: 'cancel_timer',
  launch_app: 'open_app', start_app: 'open_app', open_application: 'open_app', open_program: 'open_app', close_application: 'close_app', quit_app: 'close_app', kill_app: 'close_app', switch_to: 'focus_window', switch_window: 'focus_window', search_files: 'find_files', find_file: 'find_files', open_file: 'open_path', open_folder: 'open_path', move_file: 'move_files', delete_file: 'delete_to_recycle_bin', delete_files: 'delete_to_recycle_bin', remove_file: 'delete_to_recycle_bin', trash: 'delete_to_recycle_bin', undo: 'undo_last', volume: 'set_system_volume', lock: 'lock_screen', shutdown: 'power', restart: 'power', sleep: 'power' };

function createToolRunner(tools, { timeoutMs = 10000 } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));

  function specs() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }

  async function run(name, args, ctx = {}) {
    const tool = byName.get(name) || byName.get(ALIASES[name]);
    if (!tool) return { ok: false, text: `Error: unknown tool ${name}. Tools that exist: ${[...byName.keys()].join(', ')}. Use one of those, or say you cannot do it.` };
    // confirm tools only start from the user's own words (see brain/guard.js)
    if (tool.risk === 'confirm' && (!ctx.turn || ctx.turn.tainted)) return { ok: false, text: "Error: I won't start that from text I read. Ask me directly." };
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
