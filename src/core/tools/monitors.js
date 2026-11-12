// Voice control of the opt-in proactive monitors. It only changes settings, through the same patch path the settings window uses.
const METRICS = { cpu: 'CPU', ram: 'RAM', disk: 'Disk', temp: 'Temperature' };
const SAY = { cpu: 'CPU', ram: 'RAM', disk: 'disk', temp: 'temperature' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function createMonitorTools({ getConfig, applySettings }) {
  const stored = () => getConfig().proactive?.monitors || {};   // what is really saved, after the settings path clamped it
  const unit = (m, v) => (m === 'temp' ? `${v}°C` : `${v}%`);

  const monitorSet = {
    name: 'monitor_set',
    examples: ['warn me before a timer ends', 'alert me when memory is high', 'stop warning me about the cpu', 'notify me if the disk fills up'],   // wording the ranker matches requests against (skills/rank.js)
    needsClean: true,   // changes what JARVIS does on its own later: refused on a turn that read outside text
    direct: true,   // its result is already a sentence: it is the reply, no second model call
    hint: 'monitor_set: turn proactive warnings on or off. monitor timers (leadMin = minutes ahead) or system (metric cpu, ram, disk or temp, limit = the percent, or degrees for temp). Saying a limit or lead time turns it on. Read back the sentence it gives.',
    description: 'Turn proactive warnings on or off, or change when they fire: heads-ups before a timer ends (monitor "timers"), or warnings when the CPU, RAM, disk or temperature runs high (monitor "system").',
    params: {
      type: 'object',
      properties: {
        monitor: { type: 'string', enum: ['timers', 'system'] },
        enabled: { type: 'boolean' },
        metric: { type: 'string', enum: ['cpu', 'ram', 'disk', 'temp'] },
        limit: { type: 'number' },
        leadMin: { type: 'number' },
      },
      required: ['monitor'],
      additionalProperties: false,
    },
    async run({ monitor, enabled, limit, metric, leadMin } = {}) {
      if (monitor !== 'timers' && monitor !== 'system') throw new Error('Which warnings: "timers" (heads-up before a timer ends) or "system" (CPU, RAM, disk, temperature)?');
      const given = v => v !== undefined && v !== null;
      let key, change = {};
      if (monitor === 'timers') {
        key = 'timersSoon';
        if (given(limit) || given(metric)) throw new Error('Timer heads-ups only take leadMin, the minutes ahead. For CPU, RAM, disk or temperature use monitor "system"');
        if (given(leadMin)) change.leadMin = leadMin;
      } else {
        key = 'sysmon';
        if (given(leadMin)) throw new Error('leadMin is for timer heads-ups (monitor "timers"). System warnings take a metric and a limit');
        if (given(metric) && !METRICS[metric]) throw new Error('metric must be one of cpu, ram, disk or temp');
        if (given(limit)) {
          if (!given(metric)) throw new Error('Which metric is that limit for: cpu, ram, disk or temp?');
          change[metric] = limit;
        }
      }
      if (!given(enabled) && !Object.keys(change).length) throw new Error('Nothing to change. Say enabled (true or false)' + (monitor === 'timers' ? ', or leadMin' : ', or a metric with a limit'));
      // giving a limit or a lead time means the user wants the warning on
      change = { enabled: given(enabled) ? !!enabled : true, ...change };
      if (given(enabled) && !enabled) change = { enabled: false };   // switching off ignores any numbers said with it
      const errors = applySettings({ proactive: { monitors: { [key]: change } } });
      if (errors?.length) throw new Error(errors[0]);
      const m = stored()[key] || {};
      if (monitor === 'timers') return m.enabled ? `Upcoming-timer heads-ups are on, ${plural(m.leadMin, 'minute')} ahead.` : 'Upcoming-timer heads-ups are off.';
      if (!m.enabled) return 'System warnings are off.';
      if (metric) return `${METRICS[metric]} warnings are on at ${unit(metric, m[metric])}.`;
      return `System warnings are on: ${Object.keys(METRICS).map(k => `${SAY[k]} ${unit(k, m[k])}`).join(', ')}.`;
    },
  };
  return [monitorSet];
}

module.exports = { createMonitorTools };
