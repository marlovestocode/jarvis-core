const { createTimerTools } = require('../../tools/timers');
const { own } = require('../util');

const ALIASES = {
  set_timer: ['timer', 'start_timer', 'create_timer'],
  set_alarm: ['alarm', 'create_alarm'],
  set_reminder: ['remind_me', 'reminder', 'create_reminder'],
  list_timers: ['get_timers'],
  cancel_timer: ['delete_timer', 'stop_timer', 'cancel_alarm', 'cancel_reminder'],
};

function createGroup({ scheduler } = {}) {
  const tools = scheduler ? createTimerTools({ scheduler }) : [];
  return { id: 'timers', label: 'Timers, alarms and reminders', triggers: [], tools: tools.map(t => own(t, ALIASES[t.name] || [])) };
}

module.exports = { createGroup };
