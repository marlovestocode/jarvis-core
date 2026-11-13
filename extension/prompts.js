// Finds the two YouTube Music interruptions that stop a playlist and says which button confirms them:
//   still-listening: "Video paused. Continue watching?" / "Are you still listening?"
//   age-confirm: a content warning or maturity notice that the signed-in account can accept ("I understand and wish to proceed")
// Pure decision logic (no DOM), so it is tested in Node: decide(dialogs) → { kind, index, label } | { skip, kind } | null.
// A dialog is { text, buttons: [{ label }] }. keepalive.js turns real page elements into dialogs and clicks the answer.
//
// What it will NOT do: anything that needs the account itself. A dialog that asks to sign in, verify age with an ID or card,
// enter a birth date, or says the video is unavailable for this account is never clicked; YouTube decides who may watch.
(function (root) {
  const STILL = /\b(?:still (?:listening|watching|there)|continue (?:watching|listening)|are you (?:still )?(?:there|listening|watching)|video paused)\b/i;
  const AGE = /\b(?:confirm (?:that )?you['’]?re (?:over|at least) 18|(?:are|am) you (?:over|at least) 18|you must be (?:over )?18|age[- ]restricted|viewer discretion|inappropriate for some users|content warning|mature (?:content|audience))\b/i;
  // anything that needs the account, an ID, or says "no"
  const ACCOUNT = /\b(?:sign in|log in|verify (?:your )?age|age verification|government|id card|passport|credit card|date of birth|birthday|isn.?t available|not available|unavailable|can.?t (?:watch|play)|blocked)\b/i;
  const YES_STILL = /^(?:yes|continue(?: watching| listening)?|yes,? continue|resume|keep (?:watching|listening)|i['’]?m (?:still )?(?:here|listening|watching)|still (?:here|listening|watching))\b/i;
  const YES_AGE = /^(?:i understand(?: and wish to proceed)?|continue|proceed|yes,? i['’]?m (?:over|at least) 18|i['’]?m (?:over|at least) 18|confirm|ok(?:ay)?)\b/i;
  const NO_LABEL = /\b(?:no|cancel|dismiss|not now|exit|close|leave|sign in|log in|learn more|settings|verify|back)\b/i;

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

  function decide(dialogs) {
    let skipped = null;
    for (const d of dialogs || []) {
      const text = norm(d.text);
      if (!text || text.length > 600) continue;   // a whole page is not a dialog
      const kind = STILL.test(text) ? 'still-listening' : AGE.test(text) ? 'age-confirm' : null;
      if (!kind) continue;
      if (kind === 'age-confirm' && ACCOUNT.test(text)) { skipped = skipped || { skip: 'needs the account', kind }; continue; }
      const yes = kind === 'still-listening' ? YES_STILL : YES_AGE;
      const buttons = d.buttons || [];
      const i = buttons.findIndex(b => { const l = norm(b.label); return l && l.length <= 60 && yes.test(l) && !NO_LABEL.test(l.replace(yes, '')); });
      if (i >= 0) return { kind, index: i, label: norm(buttons[i].label) };
      skipped = skipped || { skip: 'no safe button', kind };
    }
    return skipped;
  }

  const api = { decide, STILL, AGE, ACCOUNT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JarvisPrompts = api;
})(typeof self !== 'undefined' ? self : this);
