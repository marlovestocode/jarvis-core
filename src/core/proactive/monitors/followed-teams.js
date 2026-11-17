// followedTeams monitor: says the final score of a followed team's game once. getGames() → the games of config.sports.follow
// (knowledge/sports.getScores). A game first seen already final is only announced when it started within 6 h, so a restart
// does not replay last week's results. Text is built from team names and scores only. Checked every 5 min.
const { clip } = require('./clip');

const EVERY = 5 * 60000, FRESH_MS = 6 * 3600000;
const score = v => (Number.isFinite(v) ? v : null);

function createFollowedTeamsMonitor({ getGames }) {
  return {
    id: 'followedTeams',
    enabled: cfg => !!cfg?.followedTeams?.enabled,
    async check(_snap, _cfg, state, now) {
      if (now < (state.nextAt || 0)) return null;
      state.nextAt = now + EVERY;
      const games = await getGames();
      const seen = state.seen || (state.seen = new Map());   // game key → see prev below
      for (const g of Array.isArray(games) ? games : []) {
        const key = [g?.league, g?.away, g?.home, g?.start].map(x => clip(x)).join('|');
        const prev = seen.get(key);   // undefined: new, false: seen but not final, true: final told or skipped
        if (!g || prev === true) continue;
        if (g.status !== 'final') { seen.set(key, false); continue; }
        seen.set(key, true);
        const a = score(g.score?.away), h = score(g.score?.home);
        if (a === null || h === null || (prev === undefined && !(now - Date.parse(g.start) <= FRESH_MS))) continue;
        return { kind: 'info', key: `team:${key}`, text: `Final: ${clip(g.away)} ${a}, ${clip(g.home)} ${h}.` };
      }
      return null;
    },
  };
}

module.exports = { createFollowedTeamsMonitor };
