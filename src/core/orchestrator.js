// Turn flow (spec §4): input → provider → tools → reply. Speaking is the caller's job.
const ABORTED = Symbol('aborted');
const CHARS_PER_TOKEN = 4;
const MSG_OVERHEAD_CHARS = 32;  // about 8 tokens of chat template per message (measured on the local model)
const TOOL_CHAR_WEIGHT = 1.3;   // tool JSON is about 3 chars per token, prose about 4
const REPLY_SHARE = 0.1;        // of the window, kept free for the model's answer (at most REPLY_CHARS)
const REPLY_CHARS = 4000;

function busyError() { return new Error('BUSY'); }

// Newest messages whose content fits in contextMax tokens (chars/4 estimate).
// The newest message is always sent, even when it alone is too big.
function fitWindow(messages, contextMax, reserveChars = 0) {
  if (!contextMax) return messages;
  const budget = contextMax * CHARS_PER_TOKEN - reserveChars;
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    // content, plus the template tokens around every message and any tool-call JSON the model sees
    const len = String(messages[i].content || '').length + MSG_OVERHEAD_CHARS + (messages[i].toolCalls ? JSON.stringify(messages[i].toolCalls).length : 0);
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
// route(text, { source }) → { tier, think, ... }: per-turn hints for the provider.
// promptInfo() → { hardware, media } (or a promise of it): facts for the prompt.
// fastPath(text, { source }) → null | { reply, record?, tool, ok }: a skill that answers without the model
// (media commands). An empty reply is silent; record is what the chat history keeps.
const { unbackedClaim, UNBACKED_FIX, UNTRUSTED_TOOLS, NEEDS_OK } = require('./brain/guard');

function createOrchestrator({ bus, sessions, providers, tools, getConfig, timeoutMs = 60000, maxToolRounds = 5, systemPrompt, route, selectGroups, promptInfo = () => ({}), fastPath, onQuestionLost = () => {} }) {
  let current = null; // AbortController of the running turn
  const lastGroups = new Map();   // session id → skill groups the last turn used (follow-up bonus)

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
      s.messages.push({ role: 'user', content: String(text) });
      sessions.save(s);
      bus.emit('state', { state: 'thinking' });

      if (fastPath) {
        let fp = null;
        try { fp = await fastPath(String(text), { source }); } catch (err) { bus.emit('log', { level: 'warn', text: `Skill failed, asking the model: ${err?.message || err}` }); }
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
          if (!reply) msg.silent = true;
          s.messages.push(msg);
          sessions.save(s);
          if (source !== 'voice') bus.emit('state', { state: 'idle' });
          return { reply, stopped: false, sessionId: s.id, skill: fp.tool || true };
        }
      }

      const p = pickProvider();
      const st = await providerStatus(p);
      bus.emit('provider', { id: p.id, label: p.label, ready: !!st.ready });
      const hints = route ? route(String(text), { source }) : undefined;
      const toolsOn = !!(p.capabilities?.tools && tools && hints?.tools !== false);
      // skill groups: only the groups this request needs are offered; the scope can load more mid-turn
      const scope = toolsOn && selectGroups && tools.turn ? tools.turn(selectGroups(String(text), { lastGroups: lastGroups.get(s.id) || [], source })) : null;
      const currentSpecs = () => {
        if (!toolsOn) return undefined;
        const sp = scope ? scope.specs() : tools.specs();
        return sp.length ? sp : undefined;
      };
      let useTools = currentSpecs();
      let loadedKey = scope ? scope.loaded().join() : '';
      let model = null;
      try { model = p.resolveModel ? p.resolveModel(hints || {}) : null; } catch { model = null; }
      if (hints) bus.emit('route', { tier: hints.tier, think: !!hints.think, reason: hints.reason, model });
      let sys = null;
      let info = {};
      const buildSys = () => systemPrompt({ source, now: new Date(), tools: (useTools || []).map(t => t.name), model, brief: hints?.tools === false, groupHints: scope ? scope.hints() : [], ...info });
      if (systemPrompt) {
        try { info = (await promptInfo({ source, hints })) || {}; } catch { info = {}; }
        sys = buildSys();
      }
      const t0 = Date.now();
      let firstTokenAt = 0;

      let reply = '';
      let error;
      let stopped = false;
      let toolRounds = 0;
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
        if (scope) {
          useTools = currentSpecs();
          const key = scope.loaded().join();
          if (key !== loadedKey) { loadedKey = key; if (systemPrompt) sys = buildSys(); }
        }
        // the tool definitions are part of the prompt too; JSON costs more tokens per char than prose.
        // When they were left out, a full window made Ollama cut the start of the prompt (system prompt and tools), and the model answered nothing.
        const toolChars = useTools ? Math.ceil(JSON.stringify(useTools).length * TOOL_CHAR_WEIGHT) : 0;
        let window = fitWindow(s.messages, st.contextMax, (sys ? sys.length : 0) + toolChars + Math.min(REPLY_CHARS, Math.floor((st.contextMax || 0) * CHARS_PER_TOKEN * REPLY_SHARE))).map(forProvider);
        if (sys) window = [{ role: 'system', content: sys }, ...window];
        sentChars = window.reduce((n, m) => n + String(m.content || '').length, 0);
        let round;
        try {
          round = await streamRound(p, window, useTools, ac, t => { if (!firstTokenAt) firstTokenAt = Date.now(); reply += t; }, hints);
        } catch (err) {
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
          s.messages.push({ role: 'assistant', content: reply });
          break;
        }
        if (toolRounds >= maxToolRounds) {
          error = 'Too many tool rounds';
          s.messages.push({ role: 'assistant', content: reply, error });
          break;
        }
        toolRounds++;
        s.messages.push({ role: 'assistant', content: reply, toolCalls: round.toolCalls });
        for (const call of round.toolCalls) {
          bus.emit('tool', { id: call.id, name: call.name, phase: 'start' });
          inTool = true;
          let res;
          try { res = await (scope || tools).run(call.name, call.args, { signal: ac.signal, turn }); }
          finally { inTool = false; }
          bus.emit('tool', { id: call.id, name: call.name, phase: 'end', ok: res.ok });
          if (res.untrusted || UNTRUSTED_TOOLS.has(call.name)) turn.tainted = true;
          if (res.ok && String(res.text).startsWith(NEEDS_OK)) question = String(res.text).slice(NEEDS_OK.length);
          else if (res.ok && !/^error/i.test(String(res.text)) && !res.untrusted && !UNTRUSTED_TOOLS.has(call.name) && call.name !== 'more_skills') okTools++;   // loading a skill is not an action
          s.messages.push({ role: 'tool', content: res.text, toolCallId: call.id, name: call.name });
          if (ac.signal.aborted) break;
        }
        sessions.save(s);
        if (ac.signal.aborted) { stopped = true; reply = ''; break; }
        // a risky action waits for the user's yes: ask exactly that, no more model rounds
        if (question) {
          reply = question;
          bus.emit('token', { text: reply });
          s.messages.push({ role: 'assistant', content: reply, pending: true });
          asked = true;
          break;
        }
      }

      if (scope && !error && !stopped) lastGroups.set(s.id, scope.loaded().filter(id => id !== 'core'));

      // never leave a risky action armed behind a question the user did not hear
      if (question && !asked) { try { onQuestionLost(); } catch { /* best effort */ } }
      const last = s.messages.at(-1);
      // the model said it DID something but no tool confirmed it: say so instead of leaving a false claim
      if (!error && !stopped && last?.role === 'assistant' && unbackedClaim(reply, okTools)) {
        bus.emit('token', { text: UNBACKED_FIX });
        reply += UNBACKED_FIX; last.content = reply;
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
          bus.emit('turn', { provider: p.id, model, tier: hints?.tier || null, think: !!hints?.think, promptTokens, completionTokens, ms, tps, toolRounds });
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
  };
}

module.exports = { createOrchestrator, fitWindow };
