// Wi-Fi, Bluetooth, battery, power plan and focus assist. State changes are read back; what the PC cannot report is
// "unavailable" or an error, never a made-up success.
const { matchText, norm } = require('../../media/rank');
const { own } = require('../util');

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const onOff = v => (v ? 'on' : 'off');
const attempt = async fn => { try { return { v: await fn() }; } catch (err) { return { err: err?.message || String(err) }; } };

function minutesWords(m) {
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
}

function createConnectivityTools({ host, confirm }) {
  const status = {
    name: 'connectivity_status', risk: 'safe',
    description: 'Wi-Fi, Bluetooth, battery, power plan and focus assist (do not disturb) in one reply.',
    params: obj({}),
    async run() {
      const [wifi, bt, bat, plans, focus] = await Promise.all([attempt(() => host.wifi()), attempt(() => host.bluetooth()), attempt(() => host.battery()), attempt(() => host.powerPlans()), attempt(() => host.focusAssist())]);
      const L = [];
      if (wifi.err) L.push('Wi-Fi: unavailable');
      else L.push(wifi.v.enabled ? `Wi-Fi: on, ${wifi.v.ssid ? `connected to ${wifi.v.ssid}${wifi.v.signal !== null ? ` (${wifi.v.signal}%)` : ''}` : 'not connected'}` : 'Wi-Fi: off');
      if (bt.err) L.push('Bluetooth: unavailable');
      else {
        const on = bt.v.devices.filter(d => d.connected).map(d => d.name);
        L.push(bt.v.enabled ? `Bluetooth: on, ${on.length ? `connected: ${on.join(', ')}` : 'nothing connected'}` : 'Bluetooth: off');
      }
      if (bat.err) L.push('Battery: unavailable');
      else if (!bat.v) L.push('Battery: no battery (this is a desktop)');
      else L.push(`Battery: ${bat.v.percent}%, ${bat.v.charging ? 'charging' : `on battery${bat.v.minutes ? `, about ${minutesWords(bat.v.minutes)} left` : ''}`}`);
      const active = plans.err ? null : plans.v.find(p => p.active);
      L.push(active ? `Power plan: ${active.name}` : 'Power plan: unavailable');
      L.push(focus.err || focus.v === null ? 'Focus assist: unavailable' : `Focus assist: ${onOff(focus.v)}`);
      return L.join('. ') + '.';
    },
  };

  const wifiSet = {
    name: 'wifi_set', risk: 'confirm',
    description: 'Turn Wi-Fi on or off. Asks the user first (turning it off can cut the connection JARVIS uses).',
    params: obj({ on: { type: 'boolean' } }, ['on']),
    async run({ on } = {}) {
      if (typeof on !== 'boolean') throw new Error('Say on or off');
      return confirm.propose({
        tool: 'wifi_set', summary: on ? 'Turn Wi-Fi on' : 'Turn Wi-Fi off. That can cut my own connection, so lookups and updates stop until it is back on', args: { on },
        run: async () => {
          await host.setWifi(on);
          const now = await host.wifi();
          if (now.enabled !== on) throw new Error(`Wi-Fi is still ${onOff(now.enabled)}`);
          return `Wi-Fi is ${onOff(on)}.`;
        },
      });
    },
  };

  const bluetoothSet = {
    name: 'bluetooth_set', risk: 'safe',
    description: 'Turn Bluetooth on or off.',
    params: obj({ on: { type: 'boolean' } }, ['on']),
    async run({ on } = {}) {
      if (typeof on !== 'boolean') throw new Error('Say on or off');
      await host.setBluetooth(on);
      const now = await host.bluetooth();
      if (now.enabled !== on) throw new Error(`Bluetooth is still ${onOff(now.enabled)}`);
      return `Bluetooth is ${onOff(on)}.`;
    },
  };

  const powerPlanSet = {
    name: 'power_plan_set', risk: 'confirm',
    description: 'Switch the Windows power plan by name, e.g. "power saver" or "high performance". Asks the user first.',
    params: obj({ name: { type: 'string' } }, ['name']),
    async run({ name } = {}) {
      const q = String(name || '').trim();
      if (!q) throw new Error('Which power plan?');
      const plans = await host.powerPlans();
      const best = plans.map(p => ({ p, s: norm(p.name) === norm(q) ? 1 : matchText(q, p.name) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s)[0];
      if (!best) throw new Error(`No power plan matches "${q}". Plans: ${plans.map(p => p.name).join(', ') || 'none'}.`);
      const plan = best.p;
      return confirm.propose({
        tool: 'power_plan_set', summary: `Switch the power plan to ${plan.name}`, args: { name: plan.name, id: plan.id },
        run: async () => {
          await host.setPowerPlan(plan.id);
          const now = (await host.powerPlans()).find(p => p.active);
          if (!now || now.id !== plan.id) throw new Error(`The power plan is still ${now ? now.name : 'unknown'}`);
          return `Power plan is now ${plan.name}.`;
        },
      });
    },
  };

  const focusAssist = {
    name: 'focus_assist', risk: 'safe',
    description: 'Turn focus assist (do not disturb) on or off.',
    params: obj({ on: { type: 'boolean' } }, ['on']),
    async run({ on } = {}) {
      if (typeof on !== 'boolean') throw new Error('Say on or off');
      const set = await host.focusAssist(on);
      if (set === null) throw new Error('Focus assist is not available from here on this PC');
      const now = await host.focusAssist();
      if (now !== on) throw new Error(`Focus assist is still ${onOff(now)}`);
      return `Focus assist is ${onOff(on)}.`;
    },
  };

  return [status, wifiSet, bluetoothSet, powerPlanSet, focusAssist];
}

function createGroup({ pc } = {}) {
  if (!pc) return null;
  return {
    id: 'connectivity',
    label: 'Wi-Fi, Bluetooth, battery, power plan, focus assist',
    triggers: [
      { re: /\bwi-?fi\b/i, w: 3 },
      { re: /\bpower (?:plan|saver|mode)\b/i, w: 3 },
      { words: ['internet', 'bluetooth', 'battery', 'battery saver', 'do not disturb', 'focus assist', 'focus mode'], w: 3 },
    ],
    tools: createConnectivityTools(pc).map(t => own(t)),
  };
}

module.exports = { createGroup, createConnectivityTools };
