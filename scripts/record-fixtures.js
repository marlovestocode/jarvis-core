// Live smoke + fixture recorder (not part of npm test). One real call per source, through the
// network gate, saved to test/fixtures/. Run: node scripts/record-fixtures.js [weather|news|sports|wiki ...]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPolicy } = require('../src/core/net/policy');
const { createFetcher } = require('../src/core/net/fetcher');
const { DEFAULTS } = require('../src/core/config');

const OUT = path.join(__dirname, '..', 'test', 'fixtures');
const { lat, lon } = DEFAULTS.location;
const fetcher = createFetcher({ policy: createPolicy(() => DEFAULTS), cacheDir: path.join(os.tmpdir(), 'jarvis-record-cache'), bus: { emit: (t, e) => console.log(t, JSON.stringify(e)) } });

const OM = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
  '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day' +
  '&hourly=temperature_2m,precipitation_probability,weather_code' +
  '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset' +
  '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=7';

const JOBS = {
  weather: [
    ['openmeteo-forecast.json', 'weather', OM, 'json'],
    ['openmeteo-air.json', 'weather', `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5`, 'json'],
    ['geocode-dallas.json', 'weather', 'https://geocoding-api.open-meteo.com/v1/search?name=Dallas&count=5&language=en&format=json', 'json'],
    ['geocode-springfield.json', 'weather', 'https://geocoding-api.open-meteo.com/v1/search?name=Springfield&count=5&language=en&format=json', 'json'],
    ['geocode-none.json', 'weather', 'https://geocoding-api.open-meteo.com/v1/search?name=Qwxzzyplk&count=5&language=en&format=json', 'json'],
    ['nws-alerts-point.json', 'weather', `https://api.weather.gov/alerts/active?point=${lat},${lon}`, 'json'],
    ['nws-alerts.json', 'weather', 'https://api.weather.gov/alerts/active?area=TX', 'json'],
  ],
  news: DEFAULTS.news.feeds.map((u, i) => [`news-${i}.xml`, 'news', u, 'text']),
  sports: [
    ['espn-nfl.json', 'sports', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', 'json'],
    ['espn-nba.json', 'sports', 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', 'json'],
    ['espn-mlb.json', 'sports', 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', 'json'],
    ['espn-cfb.json', 'sports', 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard', 'json'],
    ['espn-nfl-team-dal.json', 'sports', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/dal/schedule', 'json'],
  ],
  wiki: [
    ['wiki-search.json', 'wiki', 'https://en.wikipedia.org/w/rest.php/v1/search/page?q=photosynthesis&limit=5', 'json'],
    ['wiki-summary.json', 'wiki', 'https://en.wikipedia.org/api/rest_v1/page/summary/Photosynthesis', 'json'],
    ['wiki-summary-disambig.json', 'wiki', 'https://en.wikipedia.org/api/rest_v1/page/summary/Mercury', 'json'],
  ],
};

(async () => {
  const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(JOBS);
  fs.mkdirSync(OUT, { recursive: true });
  let bad = 0;
  for (const k of which) for (const [file, source, url, kind] of JOBS[k] || []) {
    try {
      const r = kind === 'json' ? await fetcher.getJson(source, url, { headers: url.includes('weather.gov') ? { Accept: 'application/geo+json' } : {} })
        : await fetcher.getText(source, url);
      fs.writeFileSync(path.join(OUT, file), kind === 'json' ? JSON.stringify(r.data, null, 1) : r.data);
      console.log('ok  ', file);
    } catch (err) { bad++; console.log('FAIL', file, err.message); }
  }
  process.exit(bad ? 1 : 0);
})();
