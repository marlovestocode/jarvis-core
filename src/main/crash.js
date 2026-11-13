// Last-resort process handlers. An uncaught exception leaves the process in an unknown state, so it is logged
// (with the stack), cleanup is attempted once, and the process exits non-zero: a crash is never hidden.
// A second exception while shutting down is only logged, never re-enters shutdown.
function installCrashHandlers({ log: rawLog, flush, exit, proc = process }) {
  let crashing = false;
  const log = (...a) => { try { rawLog(...a); } catch { /* a broken log (EPIPE) must not stop the exit */ } };
  proc.on('unhandledRejection', err => log('unhandled rejection:', err?.stack || String(err)));
  proc.on('uncaughtException', err => {
    log('uncaught exception:', err?.stack || String(err));
    if (crashing) return;
    crashing = true;
    try { flush(); } catch (e) { log('flush failed:', e?.message || String(e)); }
    exit(1);
  });
}

module.exports = { installCrashHandlers };
