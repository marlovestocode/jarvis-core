// timersSoon monitor: announces a timer or reminder once, when it comes within leadMin minutes of firing.
module.exports = {
  id: 'timersSoon',
  enabled: cfg => !!cfg?.timersSoon?.enabled,
  check(snap, cfg, state, now) {
    const up = Array.isArray(snap?.timers?.upcoming) ? snap.timers.upcoming : [];
    const told = state.told || (state.told = new Set());
    const live = new Set(up.map(t => t.id));
    for (const id of told) if (!live.has(id)) told.delete(id);
    const lead = (cfg?.timersSoon?.leadMin ?? 10) * 60000;
    for (const t of up) {
      const ms = t.due - now;
      if (!(ms > 0 && ms <= lead) || told.has(t.id)) continue;
      told.add(t.id);
      const n = Math.ceil(ms / 60000), kind = t.kind || 'timer';
      return { kind, text: `Your ${t.label ? t.label + ' ' : ''}${kind} is in ${n} minute${n === 1 ? '' : 's'}.`, key: `soon:${t.id}` };
    }
    return null;
  },
};
