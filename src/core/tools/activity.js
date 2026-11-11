// activity_log (W2 §6, plan E16): "what did you do for me today", "what failed this week", from the cortex history:
// PC actions, tool calls and plays. Read-only. Untrusted: it repeats file names, song titles and tool args from outside.
const { periodRange } = require('../music/stats');

const MAX = 1500, MAX_ACTIONS = 12;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function createActivityTool({ actionLog = null, toolHistory = null, playLog = null, now = Date.now }) {
  const when = (at, multiDay) => new Date(at).toLocaleString('en-US', multiDay ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });

  function actions(r, multi) {
    const list = actionLog.list().map(e => ({ ...e, t: Date.parse(e.at) })).filter(e => e.t >= r.from && e.t <= r.to).reverse();
    if (!list.length) return `No actions ${r.label}.`;
    const lines = list.slice(0, MAX_ACTIONS).map(e => `- ${when(e.t, multi)} ${e.what}: ${cut(e.result, 90)}${e.ok ? '' : ' (FAILED)'}`);
    return `Actions ${r.label} (${list.length}, newest first):\n${lines.join('\n')}${list.length > MAX_ACTIONS ? `\n- and ${list.length - MAX_ACTIONS} more` : ''}`;
  }

  function tools(r) {
    const s = [...toolHistory.stats({ since: r.from })].sort((a, b) => b[1].calls - a[1].calls);
    if (!s.length) return `No tool calls ${r.label}.`;
    const calls = s.reduce((n, [, x]) => n + x.calls, 0), fails = s.reduce((n, [, x]) => n + x.fails, 0);
    return `Tools ${r.label}: ${calls} tool calls, ${fails} failed. ${s.slice(0, 12).map(([name, x]) => `${name} ×${x.calls}${x.fails ? ` (${x.fails} failed)` : ''}`).join(', ')}.`;
  }

  function music(r) {
    const plays = playLog.range({ since: r.from, until: r.to + 1 });
    if (!plays.length) return `No music ${r.label}.`;
    const by = new Map();
    for (const p of plays) { const k = `${p.title}${p.artist ? ` - ${p.artist}` : ''}`; by.set(k, (by.get(k) || 0) + 1); }
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${cut(k, 60)} ×${n}`);
    const min = Math.round(plays.reduce((a, p) => a + (p.listenedSec || 0), 0) / 60);
    return `Music ${r.label}: ${plays.length} plays, ${min} min. Most played: ${top.join('; ')}.`;
  }

  return {
    name: 'activity_log',
    description: 'What JARVIS did for the user and what failed, from its own history: PC actions (moves, renames, app control) with their results, tool calls with failure counts, and music played. what: actions, tools or music (omit for all). period: today (default), yesterday, week, month, or a number of days.',
    params: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['actions', 'tools', 'music'], description: 'Which history; omit for all three.' },
        period: { type: 'string', description: 'today, yesterday, week, month, or a number of days. Default today.' },
      },
      additionalProperties: false,
    },
    risk: 'safe',
    untrusted: true,
    async run({ what, period } = {}) {
      const r = periodRange(period || 'today', now());
      const multi = r.to - r.from > 864e5;
      const parts = [];
      if ((!what || what === 'actions') && actionLog) parts.push(actions(r, multi));
      if ((!what || what === 'tools') && toolHistory) parts.push(tools(r));
      if ((!what || what === 'music') && playLog) parts.push(music(r));
      if (!parts.length) return 'That history is not available.';
      const text = parts.join('\n');
      return text.length > MAX ? text.slice(0, MAX - 1) + '…' : text;
    },
  };
}

module.exports = { createActivityTool };
