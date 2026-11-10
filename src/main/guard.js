// Our windows only ever show their own page: no navigation (e.g. a file dropped on the
// window) and no popups, so nothing else ever runs with window.jarvis exposed.
function guardWebContents(wc) {
  const block = e => e.preventDefault();
  wc.on('will-navigate', block);
  wc.on('will-redirect', block);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  return wc;
}

module.exports = { guardWebContents };
