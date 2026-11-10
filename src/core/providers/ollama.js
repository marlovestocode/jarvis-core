// Ollama provider: local /api/chat NDJSON streaming. Nothing leaves the PC.
// Model capabilities come from /api/tags + /api/show; tools are only offered to
// models that advertise them, and thinking is off unless enabled in settings.
const { abortError } = require('./provider');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const INFO_TTL = 30000;

function mapMessages(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', content: String(m.content ?? ''), tool_name: m.name };
    const o = { role: m.role, content: String(m.content ?? '') };
    if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.args || {} } }));
    return o;
  });
}

function createOllamaProvider({ getConfig, fetch: fetchImpl, statusTimeoutMs = 4000 }) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const cfg = () => getConfig().ollama || {};
  const host = () => {
    const h = String(cfg().host || DEFAULT_HOST).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h)) {
      const err = new Error('Ollama host must be local');
      err.code = 'HOST_NOT_LOCAL';
      throw err;
    }
    return h;
  };
  const model = () => String(cfg().model || '');
  const fastModel = () => String(cfg().fastModel || 'jarvis-router:latest');
  const auto = () => cfg().auto !== false;
  const keepAlive = () => String(cfg().keepAlive || '30m');
  const caches = new Map(); // host|model → { at, info }
  let lastTags = null;      // names Ollama had at the last check

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
    const tags = await getJson('/api/tags');
    lastTags = new Set((tags.models || []).filter(m => !m.remote_model && !m.remote_host).map(m => m.name));
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

  // Which model serves a turn: quick chat → fast model (when auto and present), else main.
  function resolveModel(hints = {}) {
    if (auto() && hints.tier === 'fast' && fastModel() && fastModel() !== model()) {
      if (!lastTags || lastTags.has(fastModel())) return fastModel();
    }
    return model();
  }

  const provider = {
    id: 'ollama',
    label: 'Ollama (local)',
    capabilities: { tools: true, logprobs: false, reasoning: true },

    async status() {
      let i;
      try { i = await info(); } catch (err) {
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
      const body = { model: name, messages: mapMessages(messages || []), stream: true, keep_alive: keepAlive() };
      const think = auto() && hints && typeof hints.think === 'boolean' ? hints.think : !!cfg().think;
      if (i.info.capabilities.includes('thinking')) body.think = think;
      if (tools?.length && i.info.capabilities.includes('tools')) {
        body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.params } }));
      }
      const res = await doFetch(host() + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
        redirect: 'error',
      });
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