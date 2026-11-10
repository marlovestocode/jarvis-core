// music_stats: the user's listening statistics, from the play log the YouTube Music extension fills.
const { report, REPORTS } = require('../music/stats');

function createMusicStatsTool({ playLog, playlistName = () => null }) {
  return {
    name: 'music_stats',
    description: "The user's own listening statistics from their play log (what they play, skip, repeat, when, and how their taste changes). Pick a report; reports: overview, top_artists, top_tracks, skips, time_of_day, weekday, sessions, repeats, trends, discovery, artist (needs name), sources, recent. Always call it for questions about their music taste or habits.",
    params: {
      type: 'object',
      properties: {
        report: { type: 'string', enum: REPORTS, description: 'Which statistic. overview if unsure.' },
        period: { type: 'string', description: 'today, yesterday, week, month, year, all, or a number of days. Default month.' },
        limit: { type: 'number', description: 'How many rows for top lists (default 10).' },
        name: { type: 'string', description: 'Artist name, for report=artist.' },
        by: { type: 'string', enum: ['plays', 'time'], description: 'Rank top lists by play count or listening time.' },
      },
      additionalProperties: false,
    },
    async run(args = {}) {
      const limit = Math.max(1, Math.min(25, Math.round(Number(args.limit)) || 10));
      const out = report(playLog.all(), { report: args.report || 'overview', period: args.period || 'month', limit, name: args.name, by: args.by, names: playlistName });
      return `${out.text}\n(Log covers ${playLog.count()} plays${playLog.since() ? ` since ${new Date(playLog.since()).toLocaleDateString('en-US')}` : ''}.)`;
    },
  };
}

module.exports = { createMusicStatsTool };
