// Global shortcuts. A taken or invalid accelerator is reported, never fatal.
// prev: the result of an earlier call; its accelerators are released first.
function registerHotkeys(globalShortcut, map, prev) {
  for (const accel of prev?.registered || []) {
    try { globalShortcut.unregister(accel); } catch { /* already gone */ }
  }
  const failed = [];
  const registered = [];
  for (const [accel, fn] of Object.entries(map)) {
    let ok = false;
    try { ok = globalShortcut.register(accel, fn) !== false; } catch { ok = false; }
    (ok ? registered : failed).push(accel);
  }
  return { failed, registered };
}

module.exports = { registerHotkeys };
