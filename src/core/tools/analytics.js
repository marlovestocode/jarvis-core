// JARVIS looking at his own numbers: a short summary he can say, and the dashboard page he can open.
//   metrics.summary({ from, to }) → text     metrics.query({ from, to, ... }) → the summary object (core/metrics/aggregate.js)
//   openDashboard({ range }) → the address that was opened (the app's own localhost page, shown in the default browser)
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const RANGES = { hour: 3600e3, day: 864e5, week: 7 * 864e5, month: 30 * 864e5 };
const range = r => (RANGES[r] ? r : 'day');

function createAnalyticsTools({ metrics, openDashboard } = {}) {
  if (!metrics) return [];
  const summary = {
    name: 'analytics_summary',
    hint: 'analytics_summary: how JARVIS himself has been doing (turns, reply time, skill success rate, errors, connection uptime). open_dashboard shows the same as a page with charts and filters.',
    description: 'A short summary of how JARVIS himself has been doing over the last hour, day, week or month: conversation turns, typical reply time, skill calls and their success rate, errors, questions asked instead of guessing, YouTube prompts handled, and connections that were down. Use it for "how have you been doing", "how reliable are you", "how many requests did you handle". Numbers come from his own local log; nothing is sent anywhere.',
    params: obj({ range: { type: 'string', enum: Object.keys(RANGES), description: 'how far back to look; default day' } }),
    risk: 'safe',
    async run({ range: r } = {}) {
      const key = range(r);
      const to = Date.now();
      const text = metrics.summary({ from: to - RANGES[key], to });
      return `Last ${key}: ${text}`;
    },
  };
  const dashboard = {
    name: 'open_dashboard',
    hint: 'open_dashboard: see analytics_summary.',
    description: 'Open the analytics dashboard: a page with charts and filters for how JARVIS has been performing (skill calls and success rates, reply time, errors, memory size and growth, connection uptime, conversation volume), with time ranges. Use it when the user asks to see, open or show the dashboard, analytics, statistics or charts about JARVIS himself.',
    params: obj({ range: { type: 'string', enum: Object.keys(RANGES), description: 'time range to start on; default day' } }),
    risk: 'safe',
    async run({ range: r } = {}) {
      if (!openDashboard) throw new Error('The dashboard is not available in this build');
      const url = await openDashboard({ range: range(r) });
      if (!url) throw new Error('The local dashboard server is not running, so there is no page to open');
      return `Opened the dashboard in your browser (${url}).`;
    },
  };
  return [summary, dashboard];
}

module.exports = { createAnalyticsTools, RANGES };
