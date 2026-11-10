// Confirmation for risky PC actions. A confirm tool does not act: it calls propose(), which keeps the
// exact action and returns the question. The user's next turn is read by handle() (chained first in
// the orchestrator's fastPath, so it only ever sees the user's own words): a plain yes runs that
// action once, no cancels, anything else or 60 s drops it.
// action: { tool, summary, args, run: async () → string | { text, undo }, undid? }
const { isYes, isNo, NEEDS_OK } = require('../brain/guard');

function createConfirm({ now = Date.now, ttlMs = 60000, actionLog = null }) {
  let pending = null;   // { action, at }

  function propose(action) {
    pending = { action, at: now() };
    return `${NEEDS_OK}${action.summary}. Say yes to confirm.`;
  }

  const say = (reply, tool, ok) => ({ reply, record: reply, tool, ok });

  async function handle(text) {
    if (!pending) return null;
    const { action, at } = pending;
    pending = null;
    if (now() - at > ttlMs) return null;
    if (isNo(text)) return say('Cancelled.', action.tool, true);
    if (!isYes(text)) return null;   // something else: the question is dropped, the model takes the text
    let out, ok = true, undo;
    try {
      const r = await action.run();
      out = r && typeof r === 'object' ? String(r.text) : String(r);
      undo = r && typeof r === 'object' ? r.undo : undefined;
    } catch (err) {
      ok = false;
      out = `That did not work: ${err?.message || err}.`;
    }
    const asksAgain = ok && out.startsWith(NEEDS_OK);   // e.g. still open → "force close it?"
    if (asksAgain) out = out.slice(NEEDS_OK.length);
    else actionLog?.write({ what: action.tool, args: action.args, result: out, ok, undo, undid: action.undid });
    return say(out, action.tool, ok);
  }

  return {
    propose,
    handle,
    pending: () => (pending && now() - pending.at <= ttlMs ? pending.action : null),
    clear: () => { pending = null; },
  };
}

module.exports = { createConfirm };
