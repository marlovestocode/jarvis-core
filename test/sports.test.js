const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet } = require('./helpers/fakenet');
const { getScores, formatScores, LEAGUES } = require('../src/core/knowledge/sports');
const { DEFAULTS } = require('../src/core/config');

const SB = 'https://site.api.espn.com/apis/site/v2/sports/';
const ROUTES = [
  [/football\/nfl\/scoreboard/, 'espn-nfl.json'],
  [/basketball\/nba\/scoreboard/, 'espn-nba.json'],
  [/baseball\/mlb\/scoreboard/, 'espn-mlb.json'],
  [/football\/college-football\/scoreboard/, 'espn-cfb.json'],
  [/football\/nfl\/teams\/dal\/schedule/, 'espn-nfl-team-dal.json'],
  [/football\/nfl\/teams$/, 'espn-nfl-teams.json'],
];

test('sports: league map', () => {
  assert.equal(LEAGUES.nfl.path, 'football/nfl');
  assert.equal(LEAGUES.nba.path, 'basketball/nba');
  assert.equal(LEAGUES.mlb.path, 'baseball/mlb');
  assert.equal(LEAGUES.nhl.path, 'hockey/nhl');
  assert.equal(LEAGUES.cfb.path, 'football/college-football');
  assert.equal(LEAGUES.mls.path, 'soccer/usa.1');
  assert.equal(LEAGUES.epl.path, 'soccer/eng.1');
});

test('sports: final game with score, matched by name, abbreviation or city', async () => {
  for (const team of ['Cowboys', 'DAL', 'Dallas', 'dallas cowboys']) {
    const n = fakeNet(ROUTES);
    const s = await getScores(n.fetcher, { team, league: 'nfl' }, DEFAULTS);
    const g = s.games.find(x => x.status === 'final');
    assert.ok(g, team);
    assert.equal(g.away, 'Dallas Cowboys');
    assert.equal(g.home, 'Indianapolis Colts');
    assert.deepEqual(g.score, { away: 27, home: 23 });
    assert.equal(g.league, 'NFL');
    assert.equal(g.broadcast, 'Fox');
  }
});

test('sports: no game ahead in the scoreboard → next game from the team schedule', async () => {
  const n = fakeNet(ROUTES);
  const s = await getScores(n.fetcher, { team: 'Cowboys', league: 'nfl' }, DEFAULTS);
  const next = s.games.find(x => x.status === 'scheduled');
  assert.ok(next);
  assert.equal(next.home, 'Dallas Cowboys');
  assert.equal(next.away, 'San Francisco 49ers');
  assert.equal(next.start, '2026-11-15T21:25Z');
  assert.equal(next.score, null);
  assert.ok(n.calls.some(u => u.endsWith('/football/nfl/teams/dal/schedule')));
});

test('sports: team without a league is found in the team lists', async () => {
  const n = fakeNet(ROUTES);
  const s = await getScores(n.fetcher, { team: 'Cowboys' }, DEFAULTS);
  assert.ok(s.games.some(g => g.away === 'Dallas Cowboys'));
});

test('sports: live game shows status detail; cached 2 min while live', async () => {
  const n = fakeNet([[/basketball\/nba\/scoreboard/, 'espn-live.json']]);
  const s = await getScores(n.fetcher, { team: 'Lakers', league: 'nba' }, DEFAULTS);
  const g = s.games[0];
  assert.equal(g.status, 'live');
  assert.equal(g.detail, '3rd Quarter - 5:12');
  assert.deepEqual(g.score, { home: 71, away: 78 });
  n.clock.t += 90 * 1000;
  await getScores(n.fetcher, { team: 'Lakers', league: 'nba' }, DEFAULTS);
  assert.equal(n.calls.length, 1, 'cached within 2 min');
  n.clock.t += 60 * 1000;
  await getScores(n.fetcher, { team: 'Lakers', league: 'nba' }, DEFAULTS);
  assert.equal(n.calls.length, 2, 'refreshed after 2 min while live');
});

test('sports: no live game → cached 30 min', async () => {
  const n = fakeNet(ROUTES);
  await getScores(n.fetcher, { league: 'nba' }, DEFAULTS);
  n.clock.t += 20 * 60000;
  await getScores(n.fetcher, { league: 'nba' }, DEFAULTS);
  assert.equal(n.calls.length, 1);
  n.clock.t += 11 * 60000;
  await getScores(n.fetcher, { league: 'nba' }, DEFAULTS);
  assert.equal(n.calls.length, 2);
});

test('sports: scheduled college games', async () => {
  const n = fakeNet(ROUTES);
  const s = await getScores(n.fetcher, { league: 'cfb' }, DEFAULTS);
  assert.ok(s.games.length > 0);
  assert.ok(s.games.every(g => g.status === 'scheduled' && g.score === null));
  assert.ok(s.games.length <= 12, 'capped');
});

test('sports: followed teams from config when no team is given', async () => {
  const n = fakeNet(ROUTES);
  const cfg = { ...DEFAULTS, sports: { follow: [{ league: 'nfl', team: 'Cowboys' }, { league: 'nba', team: 'Lakers' }] } };
  const s = await getScores(n.fetcher, {}, cfg);
  assert.ok(s.games.some(g => g.away === 'Dallas Cowboys'));
  assert.ok(s.games.some(g => g.away === 'Los Angeles Lakers'));
});

test('sports: nothing to go on → asks; unknown league → supported list', async () => {
  const n = fakeNet(ROUTES);
  await assert.rejects(getScores(n.fetcher, {}, DEFAULTS), /which team or league/i);
  await assert.rejects(getScores(n.fetcher, { league: 'cricket' }, DEFAULTS), /supported leagues: nfl, nba, mlb, nhl, cfb, mls, epl/i);
  assert.equal(n.calls.length, 0);
});

test('sports: unknown team → clear message', async () => {
  const n = fakeNet(ROUTES);
  const s = await getScores(n.fetcher, { team: 'Zebras', league: 'nfl' }, DEFAULTS);
  assert.equal(s.games.length, 0);
  assert.match(formatScores(s), /no .*Zebras/i);
});

test('sports: text names ESPN and age, capped', async () => {
  const n = fakeNet(ROUTES);
  const s = await getScores(n.fetcher, { team: 'Cowboys', league: 'nfl' }, DEFAULTS);
  const t = formatScores(s);
  assert.match(t, /ESPN, just now/);
  assert.match(t, /Final: Dallas Cowboys 27, Indianapolis Colts 23/);
  assert.match(t, /San Francisco 49ers at Dallas Cowboys/);
  assert.ok(t.length <= 2500);
  void SB;
});
