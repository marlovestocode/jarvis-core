'use strict';
// routine_close: the polite close a routine uses after the user's one yes for the whole run.
// It is not a model tool in practice: every call needs a single-run token that only the routine runner issues.
// Never force-kills; an app that stays open (asking to save) is left and reported.
const crypto = require('node:crypto');
const { PROTECTED } = require('../tools/pc');
const { norm } = require('../media/rank');

const TOKEN_TTL_MS = 30 * 60 * 1000;

function createTokens({ now = Date.now } = {}) {
  const live = new Map();   // token → expiry
  return {
    issue() { const t = crypto.randomBytes(12).toString('hex'); live.set(t, now() + TOKEN_TTL_MS); return t; },
    valid(t) { const e = live.get(t); if (e === undefined) return false; if (now() > e) { live.delete(t); return false; } return true; },
    revoke(t) { live.delete(t); },
  };
}

function createRoutineClose({ windowsFor, poll, host, tokens }) {
  return {
    name: 'routine_close', risk: 'safe',
    hint: 'routine_close: used by saved routines only.',
    description: 'Close an app politely as part of a saved routine. Needs a token that only a running routine has.',
    params: { type: 'object', properties: { name: { description: 'app name, e.g. "Discord"', type: 'string' }, token: { description: 'run token from the routine', type: 'string' } }, required: ['name', 'token'], additionalProperties: false },
    async run({ name, token } = {}) {
      if (!tokens.valid(token)) throw new Error('Not allowed: this only runs inside a saved routine');
      name = String(name || '').trim();
      if (!name) throw new Error('Which app should I close?');
      if (PROTECTED.has(norm(name))) throw new Error(`I won't close ${name}; Windows or JARVIS needs it`);
      const { label, ws } = await windowsFor(name);
      if (ws.some(w => PROTECTED.has(norm(w.app)))) throw new Error(`I won't close ${name}; Windows or JARVIS needs it`);
      if (!ws.length) return `${label} was not open.`;
      const pids = [...new Set(ws.map(w => w.pid))];
      for (const pid of pids) await host.closeMain(pid);
      if (await poll(async () => (await host.alive(pids)).length === 0)) return `Closed ${label}.`;
      throw new Error(`${label} is still open (it may be asking to save). I left it`);
    },
  };
}

module.exports = { createRoutineClose, createTokens };
