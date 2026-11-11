// After-chat capture (W1 §5, memory spec §5): one finished chat → a short summary (a `chat` node) and up to five
// facts the user stated about themselves, proposed as `pending` for review, with the people/pets/places they name.
// Facts come only from the user's own words: the model sees USER lines (quoted "> " lines removed), and every fact
// it returns must be made of the user's words, or it is dropped. Assistant text joins the transcript only for the
// summary, and never from a turn where a tool that reads outside text ran.
const { ftsTokens } = require('../cortex/guard');
const { entityKey } = require('./facts');

const PROMPT = 'From the USER lines only, list lasting facts the user stated about themselves, their preferences, projects, people, pets, places, routines. ' +
  "Never: opinions about the assistant, passwords, keys, numbers, one-off requests, other people's private data. " +
  'Also write a 1–3 sentence summary of the chat and up to 6 topic words. Entities: people, pets, places, projects, organisations named in the facts. ' +
  'Reply with JSON only: {"summary": "...", "topics": ["..."], "facts": [{"text": "...", "kind": "profile|note"}], "entities": [{"name": "...", "type": "person|pet|place|project|org"}]}';
const RETRY = 'Reply with JSON only.';
const MAX_FACTS = 5, MAX_ENTITIES = 6, SUPPORT = 0.6;

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const unquote = text => String(text ?? '').split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim();

function parse(reply) {
  const s = String(reply ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!j || typeof j !== 'object' || typeof j.summary !== 'string') return null;
  const arr = v => (Array.isArray(v) ? v : []);
  return {
    summary: j.summary.trim(),
    topics: arr(j.topics).filter(t => typeof t === 'string'),
    facts: arr(j.facts).filter(f => f && typeof f.text === 'string').slice(0, MAX_FACTS),
    entities: arr(j.entities).filter(e => e && typeof e.name === 'string' && e.name.trim()).slice(0, MAX_ENTITIES),
  };
}

function createExtractor({ complete, memory, chats, isUntrusted = () => false, maxChars = 3000 }) {
  // the chat as the model sees it, newest lines kept when it is too long; userText = what facts may be made of
  function transcript(session) {
    const lines = [];
    const userParts = [];
    const msgs = session.messages || [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== 'user') continue;
      const u = unquote(m.content);
      if (u) { lines.push('USER: ' + u.replace(/\s+/g, ' ')); userParts.push(u); }
      // this user message's turn: assistant text only when no outside-text tool ran in it
      let j = i + 1;
      while (j < msgs.length && msgs[j].role !== 'user') j++;
      const turn = msgs.slice(i + 1, j);
      const dirty = turn.some(t => (t.role === 'tool' && isUntrusted(t.name)) || (t.toolCalls || []).some(c => isUntrusted(c.name)));
      if (!dirty) for (const t of turn) if (t.role === 'assistant' && typeof t.content === 'string' && t.content.trim()) lines.push('ASSISTANT: ' + t.content.replace(/\s+/g, ' ').trim());
    }
    const kept = [];
    let used = 0;
    for (let k = lines.length - 1; k >= 0; k--) {
      if (used + lines[k].length + 1 > maxChars) { if (!kept.length) kept.unshift(lines[k].slice(0, maxChars)); break; }
      kept.unshift(lines[k]); used += lines[k].length + 1;
    }
    return { text: kept.join('\n'), userText: userParts.join('\n').toLowerCase() };
  }

  // a fact is the user's own words when most of its content words are in what the user wrote
  function fromUser(fact, userText) {
    const toks = ftsTokens(fact).filter(t => !['user', 'users'].includes(t));
    if (!toks.length) return false;
    return toks.filter(t => userText.includes(t)).length / toks.length >= SUPPORT;
  }

  // run(session, { signal, alive }) → { summary, proposed, entities }; throws AbortError when aborted
  async function run(session, { signal, alive = () => true } = {}) {
    const { text, userText } = transcript(session);
    const none = { summary: false, proposed: 0, entities: 0 };
    if (!text) return none;
    let messages = [{ role: 'system', content: PROMPT }, { role: 'user', content: text }];
    let out = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      if (signal?.aborted) throw abortError();
      const reply = await complete(messages, { signal });
      if (signal?.aborted) throw abortError();
      out = parse(reply);
      if (!out) messages = [...messages, { role: 'assistant', content: String(reply ?? '').slice(0, 2000) }, { role: 'user', content: RETRY }];
    }
    if (!alive()) return { ...none, gone: true };
    if (!out || !out.summary) { chats.markTried(session.id, { title: session.title }); return none; }

    const chatId = chats.upsertSummary({ sessionId: session.id, title: session.title, n: (session.messages || []).length, summary: out.summary, topics: out.topics });
    const ents = out.entities.map(e => ({ name: e.name.trim(), type: e.type, key: entityKey(e.name) }));
    let proposed = 0;
    const used = new Set();
    for (const f of out.facts) {
      if (!fromUser(f.text, userText)) continue;
      const low = f.text.toLowerCase();
      const mine = ents.filter(e => low.includes(e.name.toLowerCase()));
      const r = memory.propose({ text: f.text, tier: f.kind === 'profile' ? 'profile' : 'note', quote: f.text.slice(0, 240), sessionId: session.id,
        chatNodeId: chatId ?? null, entities: mine });
      if (r.id) { proposed++; for (const e of mine) used.add(e.key); }
    }
    if (chatId) chats.mentions(chatId, ents.map(e => e.key));
    return { summary: !!chatId, proposed, entities: used.size };
  }

  return { run };
}

module.exports = { createExtractor, PROMPT };
