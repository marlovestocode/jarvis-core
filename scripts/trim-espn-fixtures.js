// Shrinks recorded ESPN fixtures to the fields sports.js reads, and derives espn-live.json
// (one NBA game set in progress) since a recording rarely catches a live game.
//   node scripts/trim-espn-fixtures.js
const fs = require('node:fs');
const path = require('node:path');
const DIR = path.join(__dirname, '..', 'test', 'fixtures');

const team = t => ({ id: t.id, abbreviation: t.abbreviation, displayName: t.displayName, shortDisplayName: t.shortDisplayName, name: t.name, location: t.location });
const score = s => (s && typeof s === 'object' ? { value: s.value, displayValue: s.displayValue } : s);
const status = s => ({ type: { state: s.type.state, completed: s.type.completed, detail: s.type.detail, shortDetail: s.type.shortDetail } });
function event(e) {
  const c = e.competitions[0];
  return {
    id: e.id, name: e.name, date: e.date, ...(e.status ? { status: status(e.status) } : {}),
    competitions: [{
      ...(c.status ? { status: status(c.status) } : {}),
      competitors: c.competitors.map(x => ({ homeAway: x.homeAway, score: score(x.score), team: team(x.team) })),
      broadcasts: (c.broadcasts || []).map(b => (b.names ? { names: b.names } : { media: { shortName: b.media?.shortName } })),
    }],
  };
}
for (const f of fs.readdirSync(DIR).filter(f => /^espn-(nfl|nba|mlb|cfb|nfl-team-dal)\.json$/.test(f))) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const out = { ...(j.season ? { season: j.season } : {}), events: j.events.map(event) };
  fs.writeFileSync(path.join(DIR, f), JSON.stringify(out, null, 1));
}
const nba = JSON.parse(fs.readFileSync(path.join(DIR, 'espn-nba.json'), 'utf8'));
const live = JSON.parse(JSON.stringify(nba));
live.events[0].status = { type: { state: 'in', completed: false, detail: '3rd Quarter - 5:12', shortDetail: '5:12 - 3rd' } };
live.events[0].competitions[0].competitors[0].score = '71';
live.events[0].competitions[0].competitors[1].score = '78';
fs.writeFileSync(path.join(DIR, 'espn-live.json'), JSON.stringify(live, null, 1));
