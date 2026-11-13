// Turn flow (spec §4): input → provider → tools → reply. Speaking is the caller's job.
const ABORTED = Symbol('aborted');
const CHARS_PER_TOKEN = 4;
const MSG_OVERHEAD_CHARS = 32;  // about 8 tokens of chat template per message (measured on the local model)
const TOOL_CHAR_WEIGHT = 1.3;   // tool JSON is about 3 chars per token, prose about 4
const REPLY_SHARE = 0.1;        // of the window, kept free for the model's answer (at most REPLY_CHARS)
const REPLY_CHARS = 4000;
const FAIL_LIMIT = 2;           // a tool (or tool action) that failed this many times in one turn is not run again that turn
const ASK_ANSWER_WORDS = 6;     // an answer to JARVIS's own question is at most this long to be read together with the question
const ASK_DROPPED = /\b(?:never ?mind|forget it|cancel|nothing|no thanks?|stop)\b/i;
const NO_RETRY = /not running|not in Ollama|not allowed|must be local|timed out|aborted/i;   // errors a second try cannot fix
const GROUPS_TTL_MS = 15 * 60 * 1000;   // how long the last turn's skill areas count for follow-ups
const LAST_GROUPS_MAX = 64;     // sessions whose last skill groups are remembered (follow-up bonus only)

function busyError() { return new Error('BUSY'); }

// Newest messages whose content fits in contextMax tokens (chars/4 estimate).
// The newest message is always sent, even when it alone is too big.
function fitWindow(messages, contextMax, reserveChars = 0, stampChars = 0) {
  if (!contextMax) return messages;
  const budget = contextMax * CHARS_PER_TOKEN - reserveChars;
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    // content, plus the template tokens around every message and any tool-call JSON the model sees
    const len = String(messages[i].content || '').length + (messages[i].at ? stampChars : 0) + MSG_OVERHEAD_CHARS + (messages[i].toolCalls ? JSON.stringify(messages[i].toolCalls).length : 0);
    if (out.length && used + len > budget) break;
    out.unshift(messages[i]);
    used += len;
  }
  while (out.length > 1 && out[0].role === 'tool') out.shift(); // no orphan tool results
  return out;
}

// What the provider sees: no UI-only fields.
function forProvider(m) {
  const o = { role: m.role, content: m.content };
  if (m.toolCallId) o.toolCallId = m.toolCallId;
  if (m.name) o.name = m.name;
  if (m.toolCalls) o.toolCalls = m.toolCalls;
  return o;
}

// systemPrompt(ctx) → string: sent first every round, never saved.
// stamp(date) → string: added to the end of every user message that has an `at` (its send time), in the provider's copy only.
// The clock lives here, not in the system prompt, and each message keeps its own stamp, so the prompt is the same text from
// one turn to the next and the provider's cache survives the minute changing.
// route(text, { source }) → { tier, think, ... }: per-turn hints for the provider.
// promptInfo() → { hardware, media } (or a promise of it): facts for the prompt.
// fastPath(text, { source }) → null | { reply, record?, tool, ok }: a skill that answers without the model
// (media commands). An empty reply is silent; record is what the chat history keeps.
const { repairCall } = require('./tools/constrain');
const { unbackedClaim, stripClaims, softFail, ungroundedFigures, UNBACKED_FIX, NEEDS_OK } = require('./brain/guard');
const { resolveFollowUp } = require('./livestate/followup');
const { plan } = require('./brain/plan');

// A tool result the model sees is capped: a log dump or a long list swamps a small context window and the model loses the thread.
// This turn's results keep more (the model is answering from them); results from earlier turns are only a reminder.
const TOOL_CHARS_NOW = 2500;
const TOOL_CHARS_OLD = 400;
function capText(text, max) {
  const t = String(text ?? '');
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, '') + ` … [${t.length - max} more characters cut]`;
}
// What the chat lists above a reply for a tool call: "youtube_music · play · “cortisol”". A secret pick never shows its query.
function toolLabel(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const parts = [name];
  if (typeof a.action === 'string' && a.action) parts.push(a.action);
  if (!a.secret) {
    const q = [a.query, a.name, a.title, a.app, a.playlist, a.place, a.topic].find(v => typeof v === 'string' && v.trim());
    if (q) parts.push(`“${q.trim().slice(0, 40)}”`);
  }
  return parts.join(' · ');
}
// Asked of a model that answered nothing: say it once more, plainly. Never saved to the chat.
const NUDGE_AFTER_TOOL = 'Answer the user now, in one or two sentences, using the tool results above.';
const NUDGE_CLAIM = 'Your last reply said something was done, or stated what is playing, without calling a tool. Call the tool that does it or checks it now, then answer only from its result. If no tool fits, say you cannot do that.';
const nudgeGround = figs => `Your reply gave figures that appear in no tool result or message: ${figs.join(', ')}. Answer again using only the numbers the tools returned, or say you could not confirm them.`;
const NUDGE_CAP = 'You have used all the tool rounds you are allowed. Answer the user now with what the tool results above gave you, and say plainly what you could not get.';
const NUDGE_PLAIN ="Reply to the user's last message in one or two sentences.";

function createOrchestrator({ bus, sessions, providers, tools, getConfig, timeoutMs = 60000, maxToolRounds = 5, systemPrompt, stamp, route, selectGroups, promptInfo = () => ({}), fastPath, rankTools = null, learnTool = null, onQuestionLost = () => {}, memoryBlock = null, live = null, catalog = null }) {
  let current = null; // AbortController of the running turn
  const lastGroupsAt = new Map(); // session id → when lastGroups was last set
  // the areas the last turn used, only while that turn is recent: "make it 10" an hour later does not mean the timer from back then
  const recentGroups = id => (Date.now() - (lastGroupsAt.get(id) || 0) <= GROUPS_TTL_MS ? lastGroups.get(id) || [] : []);
  const lastGroups = new Map();   // session id → skill groups the last turn used (follow-up bonus)
  const pendingAsk = new Map();   // session id → the request JARVIS asked a question about ("set a timer" → "For how long?"); the next short answer is read with it
  // memoryBlock (W1 §4): { forTurn, afterTurn, onUserMessage }. lastRecall = what the last turn recalled, so a
  // correction in the next message ("no, that's wrong") can weaken it (E10).
  let lastRecall = null;

  function pickProvider() {
    const id = getConfig().provider;
    return providers.get(id) || providers.get('null');
  }

  async function providerStatus(p) {
    try { return (await p.status()) || {}; } catch (err) { return { ready: false, detail: err?.message || 'status failed' }; }
  }

  async function announce() {
    const p = pickProvider();
    const st = await providerStatus(p);
    bus.emit('provider', { id: p.id, label: p.label, ready: !!st.ready });
    return st;
  }

  // Stream one provider call. Resolves { text, toolCalls, usage }. Throws on abort/timeout/error.
  async function streamRound(p, messages, toolSpecs, ac, onText, hints) {
    const abortP = new Promise(res => {
      if (ac.signal.aborted) return res(ABORTED);
      ac.signal.addEventListener('abort', () => res(ABORTED), { once: true });
    });
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
    };
    const args = { messages, signal: ac.signal };
    if (toolSpecs) args.tools = toolSpecs;
    if (hints) args.hints = hints;
    let it;
    const toolCalls = [];
    let usage;
    arm();
    try {
      it = p.chat(args)[Symbol.asyncIterator]();
      for (;;) {
        const next = it.next();
        next.catch(() => {}); // may reject after we stop listening
        const r = await Promise.race([next, abortP]);
        if (r === ABORTED) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (r.done) break;
        arm();
        const c = r.value || {};
        if (c.type === 'token') {
          const ev = { text: String(c.text ?? '') };
          if (c.prob !== undefined) ev.prob = c.prob;
          if (c.alts !== undefined) ev.alts = c.alts;
          onText(ev.text);
          bus.emit('token', ev);
        } else if (c.type === 'reasoning') {
          bus.emit('reasoning', { chars: String(c.text ?? '').length });
        } else if (c.type === 'tool_call') {
          toolCalls.push({ id: String(c.id ?? `call${toolCalls.length}`), name: c.name, args: c.args || {} });
        } else if (c.type === 'done') {
          usage = c.usage;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      if (it && typeof it.return === 'function') {
        try { Promise.resolve(it.return()).catch(() => {}); } catch { /* ignore */ }
      }
    }
    return { toolCalls, usage };
  }

  async function send(sessionId, text, { source = 'text' } = {}) {
    if (current) throw busyError();
    const ac = new AbortController();
    current = ac;
    const lookups = new Map();
    let inTool = false;
    const offNet = bus.on('net', ev => {
      if (inTool && (ev.ok || ev.cached)) lookups.set(`${ev.source}:${ev.host}`, { source: ev.source, host: ev.host, at: ev.t, ageMs: ev.ageMs || 0, stale: !!ev.stale, offline: !!ev.offline });
    });
    try {
      let s = sessionId ? sessions.load(sessionId) : null;
      if (!s) s = sessions.create();
      s.messages.push({ role: 'user', content: String(text), at: Date.now() });
      const turnStart = s.messages.length - 1;   // tool results before this message are old
      sessions.save(s);
      if (memoryBlock) {
        try { memoryBlock.onUserMessage({ text: String(text), lastIds: lastRecall?.sessionId === s.id ? lastRecall.ids : [] }); } catch { /* memory must not break a turn */ }
        lastRecall = null;
      }
      bus.emit('state', { state: 'thinking' });

      // a short answer to JARVIS's own question ("10 minutes") is routed and matched together with the request it answers
      const asked0 = pendingAsk.get(s.id);
      pendingAsk.delete(s.id);
      const routeText = asked0 && String(text).trim().split(/\s+/).length <= ASK_ANSWER_WORDS && !ASK_DROPPED.test(String(text)) ? `${asked0} ${String(text).trim()}` : String(text);

      // live state: resolve short follow-ups ("do it again", "pause") once; any failure leaves the turn unchanged
      let fu = null;
      let snap = null;   // one snapshot per turn: follow-ups and plan() read the same one
      if (live) {
        try {
          snap = live.snapshot();
          fu = resolveFollowUp(String(text), snap) || null;
          if (fu) bus.emit('followup', { kind: fu.kind });
        } catch (err) { fu = null; bus.emit('log', { level: 'warn', text: `Live state failed, continuing without it: ${err?.message || err}` }); }
      }

      if (fastPath) {
        let fp = null;
        try { fp = await fastPath(routeText, { source, lastGroups: recentGroups(s.id), signal: ac.signal }); } catch (err) { bus.emit('log', { level: 'warn', text: `Skill failed, asking the model: ${err?.message || err}` }); }
        if (fp && !ac.signal.aborted) {
          const id = `skill${Date.now()}`;
          bus.emit('route', { tier: 'skill', think: false, reason: 'skill', model: null });
          if (fp.tool) {
            bus.emit('tool', { id, name: fp.tool, phase: 'start' });
            bus.emit('tool', { id, name: fp.tool, phase: 'end', ok: !!fp.ok });
          }
          const reply = String(fp.reply || '');
          if (reply) bus.emit('token', { text: reply });
          const msg = { role: 'assistant', content: String(fp.record ?? reply) };
          if (fp.tool) msg.skill = String(fp.tool);   // the chat lists the skill above the reply, like a tool call
          if (!reply) msg.silent = true;
          if (fp.ask) pendingAsk.set(s.id, routeText);
          s.messages.push(msg);
          sessions.save(s);
          if (source !== 'voice') bus.emit('state', { state: 'idle' });
          return { reply, stopped: false, sessionId: s.id, skill: fp.tool || true };
        }
      }

      const p = pickProvider();
      const st = await providerStatus(p);
      bus.emit('provider', { id: p.id, label: p.label, ready: !!st.ready });
      // live state: one plan() call routes the turn (follow-up, pending confirm, voice, cooldown); any failure uses the plain path below
      let planned = null;
      if (live) {
        try {
          planned = plan(routeText, snap, { source, lastGroups: fu?.kind === 'continue' ? fu.groups : recentGroups(s.id), fu, catalog, route, selectGroups: selectGroups && tools?.turn ? selectGroups : undefined });
        } catch (err) { planned = null; bus.emit('log', { level: 'warn', text: `Routing plan failed, using the plain route: ${err?.message || err}` }); }
      }
      let hints, picked;
      const avoidTools = planned?.avoid?.tools || null;   // cooling tools: not offered while another tool remains (a call by name still runs)
      const notes = planned?.notes || [];
      if (planned) {
        hints = planned.hints;
        picked = planned.picked;
      } else {
        hints = route ? route(routeText, { source }) : undefined;
        picked = selectGroups && tools?.turn ? selectGroups(routeText, { lastGroups: fu?.kind === 'continue' ? fu.groups : (recentGroups(s.id)), source }) : null;
        if (tools?.turn && fu?.kind === 'continue' && fu.groups?.length && !picked?.some(id => id !== 'core')) picked = fu.groups;
        if (fu?.kind === 'continue' && hints?.tools === false) hints = { ...hints, tier: 'deep', tools: true, think: false, reason: 'follow-up' };
      }
      // a short command ("take a screenshot") can look like chat to the router while a skill group clearly matches:
      // quick chat has no tools and would only pretend to act, so the match wins
      if (hints?.tools === false && picked?.some(id => id !== 'core' && id !== 'knowledge')) {
        hints = { ...hints, tier: 'deep', tools: true, think: false, reason: 'skill match' };
      }
      let toolsOn = !!(p.capabilities?.tools && tools && hints?.tools !== false);
      // skill groups: only the groups this request needs are offered; the scope can load more mid-turn
      let scope = toolsOn && picked ? tools.turn(picked) : null;
      const failed = new Map();     // tool or tool:action → how many times it failed this turn
      const failKey = call => call.name + (typeof call.args?.action === 'string' && call.args.action ? ':' + call.args.action : '');
      const blocked = key => (failed.get(key) || 0) >= FAIL_LIMIT;
      let forceAnswer = false;      // the tool-round limit was hit: one last round with no tools
      const currentSpecs = () => {
        if (!toolsOn || forceAnswer) return undefined;
        let sp = (scope ? scope.specs() : tools.specs()).filter(t => !blocked(t.name));
        if (avoidTools?.size) { try { const keep = sp.filter(t => !avoidTools.has(t.name)); if (keep.length) sp = keep; } catch { /* the cooldown is a nicety */ } }
        if (rankTools) { try { sp = rankTools(routeText, sp) || sp; } catch { /* ordering is a nicety */ } }   // the likeliest tools first
        return sp.length ? sp : undefined;
      };
      let useTools = currentSpecs();
      const roundCap = maxToolRounds + (hints?.steps >= 3 ? 2 : 0);   // a request that asks for several things gets a little more room
      let retriedModel = false;
      let escalated = false;
      let loadedKey = scope ? scope.loaded().join() : '';
      let model = null;
      try { model = p.resolveModel ? p.resolveModel(hints || {}) : null; } catch { model = null; }
      if (hints) bus.emit('route', { tier: hints.tier, think: !!hints.think, reason: notes.length ? [...new Set([hints.reason, ...notes].filter(Boolean))].join('; ') : hints.reason, model });
      let sys = null;
      let info = {};
      const turnNow = new Date();
      const buildSys = () => systemPrompt({ source, now: turnNow, tools: useTools || [], model, brief: hints?.tools === false, groupHints: scope ? scope.hints() : [], matchConfidence: picked?.confidence, ...info });
      if (systemPrompt) {
        try { info = (await promptInfo({ source, hints })) || {}; } catch { info = {}; }
        sys = buildSys();
      }
      // the memory block is computed once and saved on the user message, so later turns send the same text (E6)
      let recalled = [];
      if (memoryBlock) {
        const prev = s.messages.slice(0, turnStart).reverse().find(m => m.role === 'user');
        try {
          const r = await memoryBlock.forTurn({ text: String(text), previousUserText: prev ? String(prev.content) : '', brief: hints?.tools === false, profileIds: info.memoryIds || [] });
          if (r?.memo) { s.messages[turnStart].memo = String(r.memo); s.messages[turnStart].memoIds = [...(r.ids || [])]; recalled = r.ids || []; sessions.save(s); }
        } catch (err) { bus.emit('log', { level: 'warn', text: `Memory recall failed: ${err?.message || err}` }); }
      }
      const t0 = Date.now();
      let firstTokenAt = 0;

      let reply = '';
      let error;
      let stopped = false;
      let toolRounds = 0;
      let nudge = null;        // set when the model answered nothing: one more try with this added
      let emptyRetries = 0;
      let claimRetried = false;
      let groundRetried = false;
      const seenCalls = new Set();   // name+args of every call this turn
      let okTools = 0;   // tools that ran, did not fail and can back an action claim (lookups cannot)
      const turn = { source, tainted: false };   // tainted: text from outside (pages, files) came in this turn
      let question = null;   // a confirm tool is waiting for the user's yes: this is the question
      let asked = false;     // ...and the user got it (not lost to a stop or an error)
      let sentChars = 0;
      let usage;
      let completionTokens = 0;
      let promptTokens = 0;

      for (;;) {
        reply = '';
        // a group loaded last round changes the tools and the system prompt for this one
        useTools = currentSpecs();
        if (scope) {
          const key = scope.loaded().join();
          if (key !== loadedKey) { loadedKey = key; if (systemPrompt) sys = buildSys(); }
        }
        // the tool definitions are part of the prompt too; JSON costs more tokens per char than prose.
        // When they were left out, a full window made Ollama cut the start of the prompt (system prompt and tools), and the model answered nothing.
        // a memo whose item was forgotten since loses that line (memory must not keep sending what the user removed)
        if (memoryBlock?.prune) {
          for (const m of s.messages) {
            if (m.role !== 'user' || !m.memo || !Array.isArray(m.memoIds)) continue;
            let p = null;
            try { p = memoryBlock.prune(m.memo, m.memoIds); } catch { p = null; }
            if (!p) continue;
            if (p.memo) { m.memo = p.memo; m.memoIds = p.ids; } else { delete m.memo; delete m.memoIds; }
          }
        }
        const toolChars = useTools ? Math.ceil(JSON.stringify(useTools).length * TOOL_CHAR_WEIGHT) : 0;
        let window = fitWindow(s.messages.map((m, i) => (m.role === 'tool' ? { ...m, content: capText(m.content, i < turnStart ? TOOL_CHARS_OLD : TOOL_CHARS_NOW) }
          : m.role === 'user' && m.memo ? { ...m, content: `${m.content}

${m.memo}` } : m)), st.contextMax, (sys ? sys.length : 0) + toolChars + Math.min(REPLY_CHARS, Math.floor((st.contextMax || 0) * CHARS_PER_TOKEN * REPLY_SHARE)), stamp ? stamp(turnNow).length + 2 : 0).map(m => {
          const o = forProvider(m);
          if (stamp && m.role === 'user' && m.at) o.content = `${o.content}\n\n${stamp(new Date(m.at))}`;   // its own send time, the same text every turn
          return o;
        });
        if (sys) window = [{ role: 'system', content: sys }, ...window];
        if (nudge) { window = [...window, { role: 'user', content: nudge }]; nudge = null; }
        sentChars = window.reduce((n, m) => n + String(m.content || '').length, 0);
        let round;
        try {
          round = await streamRound(p, window, useTools, ac, t => { if (!firstTokenAt) firstTokenAt = Date.now(); reply += t; }, hints);
        } catch (err) {
          // a genuine call failure (not a stop or a timeout: both abort the signal) is noted in live state, so later turns can avoid the model
          if (live && model && !ac.signal.aborted) { try { bus.emit('modelfail', { model }); } catch { /* observers only */ } }
          // a model call that failed before saying anything (a crash, an HTTP 500, an out-of-memory load) is tried once more, on another
          // installed model when there is one; a timeout, a stop or a missing Ollama is not retried
          if (!ac.signal.aborted && !retriedModel && !reply && !NO_RETRY.test(err?.message || '')) {
            retriedModel = true;
            const was = model;
            try { model = p.resolveModel ? p.resolveModel({ ...(hints || {}), avoid: model }) : model; } catch { /* keep the same model */ }
            bus.emit('log', { level: 'warn', text: `Model call failed (${err?.message || err}); trying again${model && model !== was ? ` on ${model}` : ''}` });
            hints = { ...(hints || {}), avoid: was };   // the provider keeps away from the model that just failed
            continue;
          }
          if (ac.signal.aborted && ac.signal.reason === 'timeout') error = 'Model timed out';
          else if (ac.signal.aborted) stopped = true;
          else error = err?.message || String(err);
          const msg = { role: 'assistant', content: reply };
          if (stopped) msg.stopped = true;
          if (error) msg.error = error;
          s.messages.push(msg);
          break;
        }
        usage = round.usage;
        if (usage) {
          completionTokens += usage.completionTokens || 0;
          promptTokens = usage.promptTokens || promptTokens;
        }
        if (!round.toolCalls.length) {
          // an empty answer (often right after a tool) is a model hiccup, not a reply: ask once more, then fall back to the last tool result
          if (!reply.trim() && !question) {
            if (emptyRetries < 1 && !ac.signal.aborted) {
              emptyRetries++;
              nudge = toolRounds > 0 ? NUDGE_AFTER_TOOL : NUDGE_PLAIN;
              bus.emit('log', { level: 'warn', text: 'Model answered nothing; asking again' });
              continue;
            }
            const lastTool = [...s.messages].reverse().find(m => m.role === 'tool');
            if (toolRounds > 0 && lastTool && !/^error/i.test(String(lastTool.content))) {
              reply = capText(lastTool.content, 400);
              bus.emit('token', { text: reply });
            }
          }
          // text chat: the model claimed an action or a media state without calling any tool. Take that reply back and make it use a tool,
          // rather than leave a claim (voice has already spoken it, so voice only gets the correction below).
          // the router took this for quick chat (no tools) but the reply claims an action: a router miss. Redo the turn as a tool turn once.
          if (source !== 'voice' && !escalated && !useTools && hints?.tools === false && p.capabilities?.tools && tools && toolRounds === 0 && !error && unbackedClaim(reply, okTools)) {
            escalated = true;
            hints = { ...hints, tier: 'deep', tools: true, think: false, reason: 'escalated' };
            toolsOn = true;
            picked = picked || ['core', 'knowledge'];
            scope = tools.turn ? tools.turn(picked) : null;
            loadedKey = scope ? scope.loaded().join() : '';
            try { model = p.resolveModel ? p.resolveModel(hints) : null; } catch { model = null; }
            bus.emit('route', { tier: hints.tier, think: false, reason: hints.reason, model });
            useTools = currentSpecs();
            if (systemPrompt) sys = buildSys();
            nudge = NUDGE_CLAIM;
            bus.emit('retract', {});
            bus.emit('log', { level: 'warn', text: 'Quick chat claimed an action; redoing the turn with tools' });
            continue;
          }
          if (source !== 'voice' && !claimRetried && useTools && toolRounds === 0 && !error && unbackedClaim(reply, okTools)) {
            claimRetried = true;
            nudge = NUDGE_CLAIM;
            bus.emit('retract', {});
            bus.emit('log', { level: 'warn', text: 'Reply claimed an action no tool confirmed; asking again with a tool' });
            continue;
          }
          // text chat, after tools ran: a precise figure in the answer that no tool result or message contains is checked once
          if (source !== 'voice' && !groundRetried && toolRounds > 0 && !error && reply.trim()) {
            const evidence = s.messages.slice(turnStart).filter(m => m.role === 'tool' || m.role === 'user').map(m => String(m.content));
            const figs = ungroundedFigures(reply, evidence);
            if (figs.length) {
              groundRetried = true;
              nudge = nudgeGround(figs);
              bus.emit('retract', {});
              bus.emit('log', { level: 'warn', text: `Reply had figures no tool result contains (${figs.join(', ')}); asking again` });
              continue;
            }
          }
          s.messages.push({ role: 'assistant', content: reply });
          break;
        }
        if (toolRounds >= roundCap && !forceAnswer) {
          // out of rounds: no more tools, one last round to answer with what the results already gave
          forceAnswer = true;
          nudge = NUDGE_CAP;
          bus.emit('log', { level: 'warn', text: 'Tool-round limit reached; answering with what the tools returned' });
          continue;
        }
        if (toolRounds >= roundCap) {
          error = 'Too many tool rounds';
          s.messages.push({ role: 'assistant', content: reply, error });
          break;
        }
        toolRounds++;
        s.messages.push({ role: 'assistant', content: reply, toolCalls: round.toolCalls });
        const directs = [];   // each call's own result, when it can be the reply as it is
        for (const call of round.toolCalls) {
          // a call that names no tool, or whose arguments do not fit the tool's schema, is repaired by a short decode the model cannot get
          // wrong (see tools/constrain.js); a valid call costs nothing extra
          if (useTools?.length && p.constrain && getConfig().constrainTools !== false && !ac.signal.aborted) {
            const fixed = await repairCall({ provider: p, window, call, specs: useTools, resolves: n => (scope || tools).resolves?.(n) === true, signal: ac.signal, hints, log: text => bus.emit('log', { level: 'info', text }) });
            if (fixed) { call.name = fixed.name; call.args = fixed.args; }
          }
          const label = toolLabel(call.name, call.args);
          bus.emit('tool', { id: call.id, name: call.name, label, phase: 'start' });
          inTool = true;
          let res;
          // the model re-sent a call it already made this turn: do not run it again, tell it to answer
          const sig = `${call.name}:${JSON.stringify(call.args ?? {})}`;
          if (blocked(failKey(call)) || blocked(call.name)) {
            res = { ok: false, text: `Error: ${failKey(call)} already failed ${FAIL_LIMIT} times this turn. Do not call it again: use a different tool, or tell the user what failed.` };
          } else if (seenCalls.has(sig)) {
            res = { ok: false, text: 'Error: you already made this exact call this turn and got its result. Do not repeat it; answer the user with what you have, or say what failed.' };
          } else {
            seenCalls.add(sig);
            try { res = await (scope || tools).run(call.name, call.args, { signal: ac.signal, turn }); }
            finally { inTool = false; }
          }
          inTool = false;
          if (!res.ok && !res.badArgs) failed.set(failKey(call), (failed.get(failKey(call)) || 0) + 1);
          bus.emit('tool', { id: call.id, name: call.name, phase: 'end', ok: res.ok, soft: res.ok && softFail(res.text) || undefined, badArgs: res.badArgs || undefined });
          if (res.untrusted) turn.tainted = true;
          if (res.ok && String(res.text).startsWith(NEEDS_OK)) question = String(res.text).slice(NEEDS_OK.length);
          else if (res.ok && !/^error/i.test(String(res.text)) && !softFail(res.text) && !res.untrusted && call.name !== 'more_skills') okTools++;   // loading a skill is not an action
          s.messages.push({ role: 'tool', content: capText(res.text, 6000), toolCallId: call.id, name: call.name, label });
          if (learnTool && res.ok && !res.untrusted && !softFail(res.text) && !String(res.text).startsWith(NEEDS_OK)) { try { learnTool(routeText, call.name); } catch { /* learning is a nicety */ } }
          directs.push(res.ok && !res.untrusted && !turn.tainted && !String(res.text).startsWith(NEEDS_OK) && !softFail(res.text) ? ((scope || tools).direct?.(call.name, res.text) ?? null) : null);
          if (ac.signal.aborted) break;
        }
        sessions.save(s);
        if (ac.signal.aborted) { stopped = true; reply = ''; break; }
        // every call was a simple tool whose result already reads as the answer (a timer set, a conversion): that is the reply; the model is not asked to repeat it
        if (!question && !reply.trim() && directs.length && directs.every(d => d)) {
          reply = directs.join(' ');
          bus.emit('token', { text: reply });
          s.messages.push({ role: 'assistant', content: reply });
          bus.emit('log', { level: 'info', text: 'Tool result used as the reply; no second model call' });
          break;
        }
        // a risky action waits for the user's yes: ask exactly that, no more model rounds
        if (question) {
          reply = question;
          bus.emit('token', { text: reply });
          s.messages.push({ role: 'assistant', content: reply, pending: true });
          asked = true;
          break;
        }
      }

      if (memoryBlock && recalled.length && !error && !stopped) {
        try { memoryBlock.afterTurn({ ids: recalled, tainted: turn.tainted }); } catch { /* best effort */ }
        lastRecall = { sessionId: s.id, ids: recalled, tainted: turn.tainted };
      }
      if (scope && !error && !stopped) {
        lastGroups.delete(s.id);   // newest last
        lastGroups.set(s.id, scope.loaded().filter(id => id !== 'core'));
        lastGroupsAt.set(s.id, Date.now());
        if (lastGroups.size > LAST_GROUPS_MAX) { const old = lastGroups.keys().next().value; lastGroups.delete(old); lastGroupsAt.delete(old); }
      }

      // never leave a risky action armed behind a question the user did not hear
      if (question && !asked) { try { onQuestionLost(); } catch { /* best effort */ } }
      const last = s.messages.at(-1);
      // the model said it DID something but no tool confirmed it: say so instead of leaving a false claim
      if (!error && !stopped && last?.role === 'assistant' && unbackedClaim(reply, okTools)) {
        // text chat: the saved message (what the chat redraws when the turn ends) loses the false claim; voice already spoke it, so it hears the correction
        const fixed = stripClaims(reply);
        if (source === 'voice') bus.emit('token', { text: ' ' + UNBACKED_FIX });
        reply = source === 'voice' ? reply + ' ' + UNBACKED_FIX : fixed;
        last.content = reply;
        bus.emit('log', { level: 'warn', text: 'Reply claimed an action no tool confirmed' });
      }
      if (last?.role === 'assistant' && lookups.size) last.lookups = [...lookups.values()];
      sessions.save(s);
      if (error) {
        bus.emit('state', { state: 'error', detail: error });
        bus.emit('state', { state: 'idle' });
      } else {
        const used = usage && Number.isFinite(usage.promptTokens)
          ? usage.promptTokens + (usage.completionTokens || 0)
          : Math.ceil((sentChars + reply.length) / CHARS_PER_TOKEN);
        if (!stopped) bus.emit('context', { used, max: st.contextMax || null });
        if (!stopped) {
          const ms = Date.now() - t0;
          const evalMs = usage?.evalMs || (firstTokenAt ? Date.now() - firstTokenAt : 0);
          const lastTokens = usage?.completionTokens || 0;
          const tps = evalMs > 0 && lastTokens ? Math.round(lastTokens / (evalMs / 1000) * 10) / 10 : null;
          bus.emit('turn', { provider: p.id, source, model, tier: hints?.tier || null, think: !!hints?.think, promptTokens, completionTokens, ms, tps, toolRounds });
        }
        if (stopped || source !== 'voice') bus.emit('state', { state: 'idle' });
      }
      const out = { reply, stopped, sessionId: s.id };
      if (error) out.error = error;
      return out;
    } finally {
      offNet();
      if (current === ac) current = null;
    }
  }

  function stop() {
    if (current && !current.signal.aborted) current.abort('stop');
  }

  return {
    send,
    stop,
    announce,
    get busy() { return current !== null; },
    getLastGroups: sessionId => {
      if (sessionId !== undefined) return [...(lastGroups.get(sessionId) || [])];
      let last = [];
      for (const v of lastGroups.values()) last = v;   // newest last
      return [...last];
    },
    getLastGroupsAt: sessionId => {
      if (sessionId !== undefined) return lastGroupsAt.get(sessionId) ?? null;
      let last = null;
      for (const k of lastGroups.keys()) last = lastGroupsAt.get(k) ?? null;   // newest last
      return last;
    },
    stats: () => ({ sessions: lastGroups.size, cap: LAST_GROUPS_MAX }),
  };
}

module.exports = { toolLabel, createOrchestrator, fitWindow };
