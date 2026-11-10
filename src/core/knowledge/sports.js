// Scores and schedules from ESPN's public JSON. Only the league (and team code) goes out.
// Cached 2 min while a game is live, else 30 min; team lists for a week.
const { describeAge } = require('./age');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
const LEAGUES = Object.freeze({
  nfl: { path: 'football/nfl', name: 'NFL' },
  nba: { path: 'basketball/nba', name: 'NBA' },
  mlb: { path: 'baseball/mlb', name: 'MLB' },
  nhl: { path: 'hockey/nhl', name: 'NHL' },
  cfb: { path: 'football/college-football', name: 'College football' },
  mls: { path: 'soccer/usa.1', name: 'MLS' },
  epl: { path: 'soccer/eng.1', name: 'Premier League' },
});
const ALIASES = { 'college football': 'cfb', ncaaf: 'cfb', 'premier league': 'epl', football: 'nfl', basketball: 'nba', baseball: 'mlb', hockey: 'nhl', soccer: 'mls' };
const TEAM_LEAGUES = ['nfl', 'nba', 'mlb', 'nhl'];   // searched when a team is named without a league
const LIVE_TTL = 2 * 60000, TTL = 30 * 60000, TEAMS_TTL = 7 * 24 * 3600 * 1000;
const MAX_GAMES = 12, MAX_CHARS = 2500;

const low = s => String(s || '').toLowerCase().trim();
function leagueKey(l) {
  const k = low(l);
  if (!k) return '';
  const key = LEAGUES[k] ? k : ALIASES[k];
  if (!key) throw new Error(`I can't look up "${l}". Supported leagues: ${Object.keys(LEAGUES).join(', ')}.`);
  return key;
}
function teamMatches(t, q) {
  const n = low(q);
  if (!n || !t) return false;
  if (low(t.abbreviation) === n) return true;
  const names = [t.displayName, t.shortDisplayName, t.name, t.location, `${t.location} ${t.name}`].map(low);
  return names.includes(n) || names.some(x => x && (` ${x} `).includes(` ${n} `) && n.length >= 4);
}
const stateOf = e => e.status?.type || e.competitions?.[0]?.status?.type || {};
const num = s => { const v = Number(s && typeof s === 'object' ? s.value : s); return Number.isFinite(v) ? v : null; };
const STATUS = { pre: 'scheduled', in: 'live', post: 'final' };

function toGame(e, leagueName) {
  const c = e.competitions?.[0] || {};
  const home = (c.competitors || []).find(x => x.homeAway === 'home') || {};
  const away = (c.competitors || []).find(x => x.homeAway === 'away') || {};
  const st = stateOf(e);
  const status = STATUS[st.state] || 'scheduled';
  const b = (c.broadcasts || []).map(x => (x.names ? x.names.join('/') : x.media?.shortName)).filter(Boolean);
  return {
    league: leagueName, home: home.team?.displayName || '?', away: away.team?.displayName || '?',
    homeAbbr: home.team?.abbreviation || '', awayAbbr: away.team?.abbreviation || '',
    score: status === 'scheduled' ? null : { home: num(home.score), away: num(away.score) },
    status, detail: st.detail || '', start: e.date || '', broadcast: b[0] || '',
  };
}

async function scoreboard(fetcher, key) {
  const url = `${BASE}${LEAGUES[key].path}/scoreboard`;
  let r = await fetcher.getJson('sports', url, { ttlMs: TTL });
  const live = (r.data?.events || []).some(e => stateOf(e).state === 'in');
  if (live && !r.stale && r.ageMs > LIVE_TTL) r = await fetcher.getJson('sports', url, { ttlMs: LIVE_TTL });
  return r;
}

async function findTeam(fetcher, key, q) {
  try {
    const r = await fetcher.getJson('sports', `${BASE}${LEAGUES[key].path}/teams`, { ttlMs: TEAMS_TTL });
    const teams = (r.data?.sports?.[0]?.leagues?.[0]?.teams || []).map(x => x.team);
    return teams.find(t => low(t.abbreviation) === low(q)) || teams.find(t => teamMatches(t, q)) || null;
  } catch (err) { if (/lookups are off/.test(err.message)) throw err; return null; }
}

async function teamGames(fetcher, key, team) {
  const L = LEAGUES[key];
  const r = await scoreboard(fetcher, key);
  let ageMs = r.ageMs, stale = !!r.stale;
  const events = (r.data?.events || []).filter(e => (e.competitions?.[0]?.competitors || []).some(x => teamMatches(x.team, team)));
  const games = events.map(e => toGame(e, L.name));
  if (!games.some(g => g.status !== 'final')) {      // nothing live or ahead this week: the team's next game
    const abbr = (events[0]?.competitions?.[0]?.competitors || []).find(x => teamMatches(x.team, team))?.team?.abbreviation
      || (await findTeam(fetcher, key, team))?.abbreviation;
    if (abbr) {
      try {
        const s = await fetcher.getJson('sports', `${BASE}${L.path}/teams/${low(abbr)}/schedule`, { ttlMs: TTL });
        ageMs = Math.max(ageMs, s.ageMs); stale = stale || !!s.stale;
        const all = (s.data?.events || []).map(e => toGame(e, L.name));
        if (!games.length) { const last = all.filter(g => g.status === 'final').at(-1); if (last) games.push(last); }
        const next = all.find(g => g.status === 'scheduled');
        if (next) games.push(next);
      } catch (err) { if (/lookups are off/.test(err.message)) throw err; }
    }
  }
  return { games, ageMs, stale };
}

async function getScores(fetcher, { team = '', league = '' } = {}, config = {}) {
  let key = leagueKey(league);
  const out = { source: 'ESPN', team, league: key ? LEAGUES[key].name : '', games: [], ageMs: 0, stale: false };
  const add = r => { out.games.push(...r.games); out.ageMs = Math.max(out.ageMs, r.ageMs || 0); out.stale = out.stale || !!r.stale; };
  if (team) {
    if (!key) {
      for (const k of TEAM_LEAGUES) { if (await findTeam(fetcher, k, team)) { key = k; break; } }
      if (!key) return out;
      out.league = LEAGUES[key].name;
    }
    add(await teamGames(fetcher, key, team));
  } else if (key) {
    const r = await scoreboard(fetcher, key);
    add({ games: (r.data?.events || []).map(e => toGame(e, LEAGUES[key].name)), ageMs: r.ageMs, stale: r.stale });
  } else {
    const follow = config.sports?.follow || [];
    if (!follow.length) throw new Error('Which team or league? (No followed teams are set in Settings → Knowledge.)');
    for (const f of follow) {
      try { add(await teamGames(fetcher, leagueKey(f.league), f.team)); } catch (err) { if (/lookups are off/.test(err.message)) throw err; }
    }
  }
  const order = { live: 0, scheduled: 1, final: 2 };
  if (!team && key) out.games.sort((a, b) => order[a.status] - order[b.status]);
  out.games = out.games.slice(0, MAX_GAMES);
  return out;
}

function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
function line(g) {
  if (g.status === 'live') return `Live (${g.detail}): ${g.away} ${g.score.away}, ${g.home} ${g.score.home} [${g.league}]`;
  if (g.status === 'final') return `Final: ${g.away} ${g.score.away}, ${g.home} ${g.score.home} [${g.league}, ${when(g.start)}]`;
  return `Scheduled: ${g.away} at ${g.home}, ${when(g.start)}${g.broadcast ? ` on ${g.broadcast}` : ''} [${g.league}]`;
}

function formatScores(s) {
  const what = s.team || s.league || 'followed teams';
  if (!s.games.length) return `No ${s.league || ''} games found for ${what} right now (source: ESPN).`.replace(/\s+/g, ' ');
  const lines = [`Scores for ${what} (source: ${s.source}, ${describeAge(s.ageMs, s.stale)}):`];
  for (const g of s.games) {
    const l = '- ' + line(g);
    if (lines.join('\n').length + l.length + 1 > MAX_CHARS) break;
    lines.push(l);
  }
  return lines.join('\n');
}

module.exports = { getScores, formatScores, LEAGUES };
