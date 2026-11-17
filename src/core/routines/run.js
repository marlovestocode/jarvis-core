'use strict';
// Runs and undoes saved routines. A routine that closes apps asks once for the whole run (the spoken yes covers every
// close); one that does not just runs. Steps go through the task runner (saved, retried, stopped on failure). The state a
// routine changes is read before the run so undo can put it back.

const listWords = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const onOff = v => (v ? 'on' : 'off');

function stepWords(s) {
  const a = s.args || {};
  switch (s.tool) {
    case 'open_app': return `open ${a.name}`;
    case 'focus_assist': return `focus assist ${onOff(a.on)}`;
    case 'set_system_volume': return `volume ${a.percent}`;
    case 'audio_output_set': return `sound output ${a.name}`;
    case 'brightness_set': return `brightness ${a.percent ?? a.by}`;
    case 'power_plan_set': return `power plan ${a.name}`;
    case 'night_light': return `night light ${onOff(a.on)}`;
    case 'bluetooth_set': return `Bluetooth ${onOff(a.on)}`;
    case 'youtube_music': return `play ${a.query}`;
    default: return s.tool;
  }
}

function createRoutineRunner({ store, runner, confirm, tokens, snapshot, undo, log = () => {}, now = Date.now }) {
  const closes = r => r.steps.filter(s => s.tool === 'routine_close');

  function describe(routine) {
    const parts = [];
    const closing = closes(routine).map(s => s.args?.name).filter(Boolean);
    if (closing.length) parts.push(`close ${listWords(closing)}`);
    for (const s of routine.steps) if (s.tool !== 'routine_close') parts.push(stepWords(s));
    return `${routine.name}: ${parts.join(', ')}.`;
  }

  async function execute(routine, { turn, signal, sessionId } = {}) {
    const token = tokens.issue();
    try {
      let snap = null;
      try { snap = await snapshot({ steps: routine.steps }); } catch (err) { log(`routine snapshot failed: ${err?.message || err}`); }
      const steps = routine.steps.map(s => (s.tool === 'routine_close' ? { ...s, args: { ...s.args, token } } : s));
      const res = await runner.start({ title: routine.name, steps, turn: turn || { source: 'routine', tainted: false }, sessionId, signal });
      if (res?.task && snap) store.setLastRun(routine.name, { at: now(), snapshot: snap });
      return { ok: !!res?.ok, text: String(res?.text ?? '') };
    } finally { tokens.revoke(token); }
  }

  async function run(name, opts = {}) {
    const routine = store.get(name);
    if (!routine) return { ok: false, text: `I have no routine called "${name}".` };
    if (!closes(routine).length) return execute(routine, opts);
    if (opts.turn?.tainted) return { ok: false, text: `I will not run "${routine.name}" because it closes apps and this request was influenced by untrusted content. Ask me directly.` };
    const text = confirm.propose({
      tool: 'routine', summary: describe(routine), args: { name: routine.name },
      run: async () => (await execute(routine, { ...opts, turn: { source: opts.turn?.source ?? 'routine', tainted: false } })).text,
    });
    return { ok: true, text };
  }

  async function undoRun(name) {
    const routine = name ? store.get(name) : store.list().filter(r => r.lastRun).sort((a, b) => b.lastRun.at - a.lastRun.at)[0];
    if (!routine) return { ok: false, text: name ? `I have no routine called "${name}".` : 'There is nothing to undo.' };
    if (!routine.lastRun) return { ok: false, text: 'There is nothing to undo.' };
    if (routine.lastRun.undone) return { ok: false, text: `${routine.name} is already undone.` };
    const r = await undo({ snapshot: routine.lastRun.snapshot });
    store.setLastRun(routine.name, { at: routine.lastRun.at, undone: true });
    return { ok: r.ok, text: r.lines.join(' ') };
  }

  return { run, undo: undoRun, describe };
}

module.exports = { createRoutineRunner };
