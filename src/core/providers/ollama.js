// Ollama provider: local /api/chat NDJSON streaming. Nothing leaves the PC.
// Model capabilities come from /api/tags + /api/show; tools are only offered to
// models that advertise them, and thinking is off unless enabled in settings.
const { abortError } = require('./provider');
const { retry } = require('../net/retry');
const { localOrigin } = require('../net/services');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const INFO_TTL = 30000;
const DOWN_TTL = 3000;   // after a failed check, answer "not running" from memory this long instead of waiting out the timeout every turn

function mapMessages(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', content: String(m.content ?? ''), tool_name: m.name };
    const o = { role: m.role, content: String(m.content ?? '') };
    if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.args || {} } }));
    return o;
  });
}

// the same system message plus one line that asks for step-by-step reasoning before the answer
const REASON_LINE = 'This question needs care: work through it step by step, check the result, then give the final answer.';
function withReasoning(messages) {
  const out = messages.map(m => ({ ...m }));
  const i = out.findIndex(m => m.role === 'system');
  if (i >= 0) out[i].content = `${out[i].content}

${REASON_LINE}`;
  else out.unshift({ role: 'system', content: REASON_LINE });
  return out;
}

// "8.2B" -> 8.2, "137M" -> 0.137; unknown -> 0
function paramBillions(label) {
  const m = /^([\d.]+)\s*([KMBT])/i.exec(String(label || ''));
  if (!m) return 0;
  return parseFloat(m[1]) * ({ K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[m[2].toUpperCase()]);
}

function createOllamaProvider({ getConfig, fetch: fetchImpl, statusTimeoutMs = 4000, connectRetries = 2, retryBaseMs = 400, now = Date.now, log = () => {} }) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const cfg = () => getConfig().ollama || {};
  const host = () => {
    const h = localOrigin(cfg().host, DEFAULT_HOST);
    if (!h) {
      const err = new Error('Ollama host must be local');
      err.code = 'HOST_NOT_LOCAL';
      throw err;
    }
    return h;
  };
  const model = () => String(cfg().model || '');
  const fastModel = () => String(cfg().fastModel || '');  // '' = quick chat on the main model
  const auto = () => cfg().auto !== false;
  const keepAlive = () => String(cfg().keepAlive || '30m');
  const caches = new Map(); // host|model → { at, info }
  let lastTags = null;      // names Ollama had at the last check
  let loadedNow = null;     // names of the models in VRAM at the last check (/api/ps), or null when unknown
  let lastModels = null;    // [{ name, size (billions of parameters), caps }]: the local chat models Ollama had at the last check
  let down = null;          // { at, err }: the last connection failure
  const health = { ok: null, lastOkAt: 0, lastError: '', retries: 0, failures: 0 };

  async function getJson(path, body) {
    const res = await doFetch(host() + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(statusTimeoutMs),
      redirect: 'error',
    });
    if (!res.ok) {
      const e = await res.json().catch(() => null);
      throw new Error(e?.error || `Ollama HTTP ${res.status}`);
    }
    return res.json();
  }

  // tags + show for one model, cached briefly (status runs per turn).
  async function info(name = model()) {
    const key = host() + '|' + name;
    const hit = caches.get(key);
    if (hit && Date.now() - hit.at < INFO_TTL) return hit;
    if (down && now() - down.at < DOWN_TTL) throw down.err;
    let tags;
    try { tags = await getJson('/api/tags'); } catch (err) {
      if (!err.code) { down = { at: now(), err }; health.ok = false; health.failures++; health.lastError = err.message; }   // not running (no model-level code)
      throw err;
    }
    down = null; health.ok = true; health.lastOkAt = now();
    lastTags = new Set((tags.models || []).filter(m => !m.remote_model && !m.remote_host).map(m => m.name));
    // an Ollama that does not report capabilities in /api/tags leaves lastModels empty: the main model is then used as configured
    const local = (tags.models || []).filter(m => !m.remote_model && !m.remote_host);
    lastModels = local.some(m => m.capabilities?.length) ? local.filter(m => m.capabilities?.includes('completion')).map(m => ({ name: m.name, size: paramBillions(m.details?.parameter_size), caps: m.capabilities })) : null;
    try { loadedNow = new Set(((await getJson('/api/ps')).models || []).map(m => m.name)); } catch { loadedNow = null; }
    const entry = (tags.models || []).find(m => m.name === name);
    if (!entry) {
      const err = new Error(`Model "${name}" is not in Ollama. Pull it or pick another in settings.`);
      err.code = 'MODEL_MISSING';
      throw err;
    }
    if (entry.remote_model || entry.remote_host) {
      const err = new Error('Cloud-backed Ollama models are not allowed');
      err.code = 'MODEL_REMOTE';
      throw err;
    }
    let show = null;
    try { show = await getJson('/api/show', { name }); } catch { /* tags data is enough */ }
    const numCtx = show?.parameters?.match(/num_ctx\s+(\d+)/);
    const next = {
      at: Date.now(),
      info: {
        capabilities: entry.capabilities || show?.capabilities || [],
        contextMax: numCtx ? +numCtx[1] : (entry.details?.context_length || undefined),
        detail: [entry.details?.parameter_size, entry.details?.quantization_level].filter(Boolean).join(' '),
      },
    };
    caches.set(key, next);
    return next;
  }

  // Which model serves a turn, from what the turn needs and what is installed:
  //   quick chat → the fast model (when auto and installed); otherwise the main model.
  //   The main model is swapped only when it cannot do the turn: it is not installed, it has no tool support and the turn needs tools,
  //   or it cannot think and the turn asks for thinking. The swap is the installed model closest in size to the main one that can.
  //   hints.avoid names a model that just failed: another one serves the retry when there is another.
  function resolveModel(hints = {}) {
    const main = model();
    const avoid = hints.avoid || null;
    // plan() asks for the fast model (prefer: 'fast') only for single-step voice turns: honored only when the fast model can serve the turn
    if (hints.prefer === 'fast' && auto() && fastModel() && fastModel() !== main && fastModel() !== avoid
      && (!lastTags || lastTags.has(fastModel())) && (!lastModels || lastModels.find(m => m.name === fastModel())?.caps.includes('tools'))) return fastModel();
    if (auto() && hints.tier === 'fast' && fastModel() && fastModel() !== main && fastModel() !== avoid) {
      if (!lastTags || lastTags.has(fastModel())) return fastModel();
    }
    if (!lastModels) return main;   // nothing known about the installed models yet: the main one, as configured
    const have = lastModels.find(m => m.name === main);
    const needTools = hints.tools !== false;
    const needThink = auto() && !!hints.think;
    const can = m => m.name !== avoid && (!needTools || m.caps.includes('tools')) && (!needThink || m.caps.includes('thinking'));
    if (have && main !== avoid && (!auto() || (!needTools || have.caps.includes('tools')) && (!needThink || have.caps.includes('thinking')))) return main;
    const ref = have ? have.size : 6;   // an uninstalled main model: aim for a mid-size local model
    const pool = lastModels.filter(m => m.caps.includes('completion'));
    const pick = list => [...list].sort((a, b) => Math.abs(a.size - ref) - Math.abs(b.size - ref) || b.size - a.size)[0];
    // a turn that needs tools and thinking prefers a model with both; if none exists it settles for what it can get
    // the main model only lacks thinking: swapping would load a second model into VRAM (seconds on a small GPU, and the main one may be evicted),
    // so only a model that is already loaded is worth it; otherwise the main model answers and chat() asks it to reason in the prompt
    if (have && main !== avoid && (!needTools || have.caps.includes('tools'))) {
      const resident = pick(pool.filter(m => can(m) && loadedNow?.has(m.name)));
      return resident ? resident.name : main;
    }
    const best = pick(pool.filter(can)) || pick(pool.filter(m => m.name !== avoid && (!needTools || m.caps.includes('tools')))) || pick(pool.filter(m => m.name !== avoid));
    if (!best) return main;
    if (!have || main === avoid || auto()) return best.name;
    return main;
  }

  const provider = {
    id: 'ollama',
    label: 'Ollama (local)',
    capabilities: { tools: true, logprobs: false, reasoning: true },

    async status() {
      let i;
      try { i = await info(); } catch (err) {
        // the main model is gone: still not ready (the user picked it), but turns are served by the closest installed model that can, and the detail says which
        if (err.code === 'MODEL_MISSING' && lastModels?.length) {
          const alt = resolveModel({ tools: true });
          if (alt && alt !== model()) return { ready: false, detail: `${err.message} ${alt} answers in its place.`, fallback: alt };
        }
        return { ready: false, detail: ['MODEL_MISSING', 'MODEL_REMOTE', 'HOST_NOT_LOCAL'].includes(err.code) ? err.message : 'Ollama is not running' };
      }
      return { ready: true, detail: `${model()}${i.info.detail ? ' · ' + i.info.detail : ''}`, contextMax: i.info.contextMax };
    },

    async listModels() {
      const tags = await getJson('/api/tags');
      return (tags.models || [])
        .filter(m => !m.remote_model && !m.remote_host)
        .map(m => ({ id: m.name, label: m.name + (m.details?.parameter_size ? ` · ${m.details.parameter_size}` : '') }));
    },

    resolveModel,
    health: () => ({ ...health }),

    // Load the main (and fast) model into VRAM so the first answer is quick. Never throws.
    async warm() {
      const names = [model()];
      if (auto() && fastModel() && fastModel() !== model()) names.push(fastModel());
      const loaded = [];
      try {
        for (const name of names) {
          try { await info(name); } catch (err) { if (err.code === 'MODEL_MISSING') continue; throw err; }
          await getJson('/api/generate', { model: name, prompt: '', keep_alive: keepAlive() }).catch(() => {});
          loaded.push(name);
        }
        return { loaded };
      } catch (err) {
        return { loaded, error: err.code === 'HOST_NOT_LOCAL' ? err.message : 'Ollama is not running' };
      }
    },

    // One short, non-streaming call whose output has to match a JSON schema (Ollama structured output: a grammar the sampler must
    // follow, so a tool name outside the list or an argument outside its enum cannot come out). Same model as the chat round, so
    // nothing reloads and the prompt prefix is already cached. → the parsed object, or null (never throws except on abort).
    async constrain({ messages, schema, signal, hints } = {}) {
      if (signal?.aborted) throw abortError();
      const name = resolveModel(hints || {});
      let i;
      try { i = await info(name); } catch { return null; }
      const body = { model: name, messages: mapMessages(messages || []), stream: false, format: schema, keep_alive: keepAlive(), options: { temperature: 0, num_predict: 300 } };
      if (i.info.capabilities.includes('thinking')) body.think = false;
      const limit = AbortSignal.timeout(20000);
      let res;
      try {
        res = await doFetch(host() + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, limit]) : limit, redirect: 'error' });
      } catch (err) { if (signal?.aborted) throw abortError(); return null; }
      if (!res.ok) return null;
      try { return JSON.parse((await res.json()).message?.content || ''); } catch { return null; }
    },

    async *chat({ messages, tools, signal, hints } = {}) {
      if (signal?.aborted) throw abortError();
      let i = null;
      let name = resolveModel(hints || {});
      try { i = await info(name); } catch (err) {
        if (err.code === 'MODEL_MISSING' && name !== model()) {   // fast model gone: use the main one
          name = model();
          try { i = await info(name); } catch (e2) { err = e2; i = null; }
        }
        if (!i) {
          if (['MODEL_MISSING', 'MODEL_REMOTE', 'HOST_NOT_LOCAL'].includes(err.code)) throw err;
          throw new Error('Ollama is not running');
        }
      }
      let sent = messages || [];
      // thinking asked for, but this model has no thinking mode: ask it to reason in the prompt instead
      if (auto() && hints && hints.think === true && !i.info.capabilities.includes('thinking')) sent = withReasoning(sent);
      const body = { model: name, messages: mapMessages(sent), stream: true, keep_alive: keepAlive() };
      const think = auto() && hints && typeof hints.think === 'boolean' ? hints.think : !!cfg().think;
      if (i.info.capabilities.includes('thinking')) body.think = think;
      if (tools?.length && i.info.capabilities.includes('tools')) {
        body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.params } }));
      }
      // Ollama restarting or still binding refuses the connection for a moment: retry the connect (never a started stream)
      let res;
      try {
        res = await retry(() => doFetch(host() + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
          redirect: 'error',
        }), { retries: connectRetries, baseMs: retryBaseMs, signal, onRetry: r => { health.retries++; log(`ollama: connect failed (${r.error.message}), retry ${r.attempt} in ${r.wait} ms`); } });
      } catch (err) {
        if (signal?.aborted) throw abortError();
        health.ok = false; health.failures++; health.lastError = err.message; down = { at: now(), err: new Error('Ollama is not running') };
        throw new Error('Ollama is not running');
      }
      health.ok = true; health.lastOkAt = now(); down = null;
      if (!res.ok) {
        const e = await res.json().catch(() => null);
        throw new Error(e?.error || `Ollama HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', calls = 0, done = false;
      try {
        for (;;) {
          if (signal?.aborted) throw abortError();
          const r = await reader.read();
          if (r.done) break;
          buf += dec.decode(r.value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const j = JSON.parse(line);
            if (j.error) throw new Error(j.error);
            const m = j.message || {};
            if (m.thinking) yield { type: 'reasoning', text: String(m.thinking) };
            if (m.content) yield { type: 'token', text: String(m.content) };
            for (const tc of m.tool_calls || []) {
              yield { type: 'tool_call', id: `call${calls++}`, name: tc.function?.name, args: tc.function?.arguments || {} };
            }
            if (j.done) {
              done = true;
              const usage = { promptTokens: j.prompt_eval_count, completionTokens: j.eval_count };
              if (j.eval_duration) usage.evalMs = Math.round(j.eval_duration / 1e6);
              yield { type: 'done', usage };
              return;
            }
          }
        }
        if (!done) throw new Error('Ollama stream ended early');
      } finally {
        try { await reader.cancel(); } catch { /* already closed */ }
      }
    },
  };
  return provider;
}

module.exports = { createOllamaProvider, mapMessages, DEFAULT_HOST };