// Timers, alarms and reminders for the model. The scheduler persists each one before we say it is set.
const { parseDuration, parseWhen, sayTime } = require('../timers/parse');

const MAX_TIMER_MS = 7 * 864e5;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function sayDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const out = [];
  if (h) out.push(plural(h, 'hour'));
  if (m) out.push(plural(m, 'minute'));
  if (s && !h) out.push(plural(s, 'second'));
  return out.join(' ') || '0 seconds';
}

function createTimerTools({ scheduler, now = Date.now }) {
  const when = (text, what) => {
    const r = parseWhen(text, now());
    if (!r) throw new Error(`Could not read "${text}" as a time. Say something like "7:30 am", "tomorrow at 9" or "in 20 minutes"`);
    return r.at;
  };
  const done = at => sayTime(at, now()).replace(/ today$/, '');

  const setTimer = {
    name: 'set_timer',
    description: 'Start a countdown timer. Give seconds, or duration_text like "10 minutes"; label is optional.',
    params: { type: 'object', properties: { seconds: { type: 'number' }, duration_text: { type: 'string' }, label: { type: 'string' } }, additionalProperties: false },
    async run({ seconds, duration_text: text, label = '' } = {}) {
      let ms = null;
      if (Number.isFinite(seconds) && seconds > 0) ms = seconds * 1000;
      else if (text) { ms = parseDuration(text); if (!ms) throw new Error(`Could not read "${text}" as a length of time. Say something like "10 minutes"`); }
      if (!ms) throw new Error('How long should the timer run?');
      if (ms > MAX_TIMER_MS) throw new Error('Timers run up to 7 days. For later than that, set an alarm or a reminder');
      const t = scheduler.add({ kind: 'timer', label, due: now() + ms });
      return `${t.label ? cap(t.label) + ' timer' : 'Timer'} set for ${sayDuration(ms)}, done at ${done(t.due)}.`;
    },
  };

  const setAlarm = {
    name: 'set_alarm',
    description: 'Set an alarm for a clock time, e.g. at "7:30 am" or "tomorrow at 9". label is optional.',
    params: { type: 'object', properties: { at: { type: 'string' }, label: { type: 'string' } }, required: ['at'], additionalProperties: false },
    async run({ at, label = '' } = {}) {
      if (!at) throw new Error('What time should the alarm go off?');
      const t = scheduler.add({ kind: 'alarm', label, due: when(at) });
      return `${t.label ? cap(t.label) + ' alarm' : 'Alarm'} set for ${sayTime(t.due, now())}.`;
    },
  };

  const setReminder = {
    name: 'set_reminder',
    description: 'Remind the user of something. text is what to remind; give at (a clock time) or in (a delay like "20 minutes").',
    params: { type: 'object', properties: { text: { type: 'string' }, at: { type: 'string' }, in: { type: 'string' } }, required: ['text'], additionalProperties: false },
    async run({ text, at, in: delay } = {}) {
      const what = String(text || '').trim().replace(/^to\s+/i, '');
      if (!what) throw new Error('What should I remind you about?');
      let due;
      if (delay) { const ms = parseDuration(delay); if (!ms) throw new Error(`Could not read "${delay}" as a length of time`); due = now() + ms; }
      else if (at) due = when(at);
      else throw new Error('When should I remind you?');
      const t = scheduler.add({ kind: 'reminder', label: what, due });
      return `I will remind you to ${what.charAt(0).toLowerCase() + what.slice(1)} at ${sayTime(t.due, now())}.`;
    },
  };

  const name = t => (t.kind === 'reminder' ? `Reminder to ${t.label}` : t.label ? `${cap(t.label)} ${t.kind}` : cap(t.kind));

  const listTimers = {
    name: 'list_timers',
    description: 'List the timers, alarms and reminders that are set.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const list = scheduler.list();
      if (!list.length) return 'No timers set.';
      return list.map(t => `${name(t)}: ${t.kind === 'timer' ? `${sayDuration(Math.ceil((t.due - now()) / 60e3) * 60e3)} left, ` : ''}at ${sayTime(t.due, now())}.`).join('\n');
    },
  };

  const cancelTimer = {
    name: 'cancel_timer',
    description: 'Cancel a timer, alarm or reminder by label or id, or all of them with all: true.',
    params: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, all: { type: 'boolean' } }, additionalProperties: false },
    async run({ id, label, all } = {}) {
      if (!all && !id && !label) {
        const list = scheduler.list();
        if (list.length !== 1) throw new Error(list.length ? `Which timer? Set: ${list.map(name).join('; ')}` : 'No timers are set');
        id = list[0].id;
      }
      const gone = scheduler.cancel(all ? { all: true } : id ? { id } : { label });
      if (!gone.length) throw new Error(`No timer matches "${label || id}"`);
      if (gone.length > 1) return `Cancelled ${plural(gone.length, 'timer')}.`;
      const t = gone[0];
      return t.kind === 'reminder' ? `Cancelled the reminder to ${t.label}.` : `Cancelled the ${t.label ? t.label + ' ' : ''}${t.kind}.`;
    },
  };

  return [setTimer, setAlarm, setReminder, listTimers, cancelTimer];
}

module.exports = { createTimerTools, sayDuration };
