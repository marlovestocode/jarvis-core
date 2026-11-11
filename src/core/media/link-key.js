// The key JARVIS and its browser extension share. It is made once, kept in the app's data folder, and copied
// by the user into the extension popup (tray menu → "Copy extension link key"). Every connection proves it knows
// the key in both directions, so neither side talks to a stranger on a local port.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY_RE = /^[0-9a-f]{64}$/;

function loadOrCreateLinkKey(file, { log = () => {} } = {}) {
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (KEY_RE.test(k)) return k;
  } catch { /* none yet */ }
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  } catch (err) { log('link key not saved: ' + err.message); }
  return key;
}

const proof = (key, ...parts) => crypto.createHmac('sha256', key).update(parts.join('|')).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

module.exports = { loadOrCreateLinkKey, proof, same, KEY_RE };
