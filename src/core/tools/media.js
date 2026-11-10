// media_control: presses a media key through sysmon (POST /media/<action>, needs an Origin header).
const { SYSMON } = require('./sysmon');

const ACTIONS = ['playpause', 'next', 'prev', 'stop', 'mute', 'volup', 'voldown'];
const DONE = { playpause: 'Toggled play/pause', next: 'Skipped to next track', prev: 'Went to previous track', stop: 'Stopped playback', mute: 'Toggled mute', volup: 'Volume up', voldown: 'Volume down' };

function createMediaTool({ fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  return {
    name: 'media_control',
    description: 'Control media playback on this PC: play/pause, next, previous, stop, mute, volume up/down.',
    params: {
      type: 'object',
      properties: { action: { type: 'string', enum: ACTIONS } },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args = {}) {
      const action = args.action;
      if (!ACTIONS.includes(action)) throw new Error(`Unknown media action "${action}". Use one of: ${ACTIONS.join(', ')}`);
      let r;
      try {
        r = await fetch(`${SYSMON}/media/${action}`, { method: 'POST', headers: { Origin: 'http://127.0.0.1' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new Error('Sysmon is not running');
      }
      if (r.status === 204 || r.ok) return DONE[action];
      if (r.status === 429) throw new Error('Too fast, try again in a moment');
      if (r.status === 503) throw new Error('Media keys unavailable');
      throw new Error(`Sysmon refused the media key (HTTP ${r.status})`);
    },
  };
}

module.exports = { createMediaTool, ACTIONS };
