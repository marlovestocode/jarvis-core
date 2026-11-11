// Is the timer being set inside a tainted turn (one that read a page, a file or other outside text)? The timer tools
// and the scheduler keep their interfaces, so the timers skill group runs each tool call inside this scope and the
// cortex timer store reads it: a reminder from a tainted turn is not written with the user's trust. The tools reach the
// store synchronously (no await before scheduler.add), so a plain scoped flag is enough.
let current = false;

function runTainted(tainted, fn) {
  const prev = current;
  current = !!tainted;
  try { return fn(); } finally { current = prev; }
}

const isTainted = () => current;

module.exports = { runTainted, isTainted };
