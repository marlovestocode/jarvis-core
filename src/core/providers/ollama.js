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
  let cache = { key: '', at: 0, tags: null, info: null };

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

  // tags + show for the configured model, cached briefly (status runs per turn).
  async function info() {
    const key = host() + '|' + model();
    if (cache.key === key && Date.now() - cache.at < INFO_TTL) return cache;
    const tags = await getJson('/api/tags');
    const entry = (tags.models || []).find(m => m.name === model());
    if (!entry) {
      const err = new Error(`Model "${model()}" is not in Ollama. Pull it or pick another in settings.`);
      err.code = 'MODEL_MISSING';
      throw err;
    }
    if (entry.remote_model || entry.remote_host) {
      const err = new Error('Cloud-backed Ollama models are not allowed');
      err.code = 'MODEL_REMOTE';
      throw err;
    }
    let show = null;
    try { show = await getJson('/api/show', { name: model() }); } catch { /* tags data is enough */ }
    const numCtx = show?.parameters?.match(/num_ctx\s+(\d+)/);
    const next = {
      key, at: Date.now(), tags,
      info: {
        capabilities: entry.capabilities || show?.capabilities || [],
        contextMax: numCtx ? +numCtx[1] : (entry.details?.context_length || undefined),
        detail: [entry.details?.parameter_size, entry.details?.quantization_level].filter(Boolean).join(' '),
      },
    };
    cache = next;
    return next;
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

    async *chat({ messages, tools, signal } = {}) {
      if (signal?.aborted) throw abortError();
      let i = null;
      try { i = await info(); } catch (err) {
        if (['MODEL_MISSING', 'MODEL_REMOTE', 'HOST_NOT_LOCAL'].includes(err.code)) throw err;
        throw new Error('Ollama is not running');
      }
      const body = { model: model(), messages: mapMessages(messages || []), stream: true };
      if (i.info.capabilities.includes('thinking')) body.think = !!cfg().think;
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
              yield { type: 'done', usage: { promptTokens: j.prompt_eval_count, completionTokens: j.eval_count } };
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