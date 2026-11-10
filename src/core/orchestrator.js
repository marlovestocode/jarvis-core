// Turn flow (spec §4): input → provider → tools → reply. Speaking is the caller's job.
const ABORTED = Symbol('aborted');
const CHARS_PER_TOKEN = 4;

function busyError() { return new Error('BUSY'); }

// Newest messages whose content fits in contextMax tokens (chars/4 estimate).
// The newest message is always sent, even when it alone is too big.
function fitWindow(messages, contextMax, reserveChars = 0) {
  if (!contextMax) return messages;
  const budget = contextMax * CHARS_PER_TOKEN - reserveChars;
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const len = String(messages[i].content || '').length;
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
// promptInfo() → { hardware }: facts for the prompt.
function createOrchestrator({ bus, sessions, providers, tools, getConfig, timeoutMs = 60000, maxToolRounds = 5, systemPrompt, route, promptInfo = () => ({}) }) {
  let current = null; // AbortController of the running turn

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
    try {
      let s = sessionId ? sessions.load(sessionId) : null;
      if (!s) s = sessions.create();
      s.messages.push({ role: 'user', content: String(text) });
      sessions.save(s);
      bus.emit('state', { state: 'thinking' });

      const p = pickProvider();
      const st = await providerStatus(p);
      bus.emit('provider', { id: p.id, label: p.label, ready: !!st.ready });
      const hints = route ? route(String(text), { source }) : undefined;
      const toolSpecs = p.capabilities?.tools && tools && hints?.tools !== false ? tools.specs() : undefined;
      const useTools = toolSpecs && toolSpecs.length ? toolSpecs : undefined;
      let model = null;
      try { model = p.resolveModel ? p.resolveModel(hints || {}) : null; } catch { model = null; }
      if (hints) bus.emit('route', { tier: hints.tier, think: !!hints.think, reason: hints.reason, model });
      let sys = null;
      if (systemPrompt) {
        let info = {};
        try { info = promptInfo() || {}; } catch { info = {}; }
        sys = systemPrompt({ source, now: new Date(), tools: (useTools || []).map(t => t.name), model, brief: hints?.tools === false, ...info });
      }
      const t0 = Date.now();
      let firstTokenAt = 0;

      let reply = '';
      let error;
      let stopped = false;
      let toolRounds = 0;
      let sentChars = 0;
      let usage;
      let completionTokens = 0;
      let promptTokens = 0;

      for (;;) {
        reply = '';
        let window = fitWindow(s.messages, st.contextMax, sys ? sys.length : 0).map(forProvider);
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
          const res = await tools.run(call.name, call.args, { signal: ac.signal });
          bus.emit('tool', { id: call.id, name: call.name, phase: 'end', ok: res.ok });
          s.messages.push({ role: 'tool', content: res.text, toolCallId: call.id, name: call.name });
          if (ac.signal.aborted) break;
        }
        sessions.save(s);
        if (ac.signal.aborted) { stopped = true; reply = ''; break; }
      }

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
