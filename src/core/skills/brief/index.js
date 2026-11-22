'use strict';
// Fast-path skill: "morning brief" and its few spoken forms speak the brief with no model call.
// It is not a tool group (skills/index.js ORDER does not list it); the orchestrator reaches it through fastPath.
const PHRASES = new Set([
  'morning brief', 'my morning brief', 'brief me', 'give me the brief', 'give me my brief',
  'whats my day look like', 'what does my day look like',
]);

const clean = text => String(text || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/^(?:please|hey jarvis|jarvis)\s+/, '').replace(/\s+/g, ' ').trim();

function createBriefSkill({ brief }) {
  async function handle(text) {
    if (!PHRASES.has(clean(text))) return null;
    try {
      const reply = await brief.build();
      return { reply, record: reply, tool: 'morning_brief', ok: true };
    } catch {
      return { reply: 'I could not put the brief together just now.', tool: 'morning_brief', ok: false };
    }
  }
  return { handle };
}

module.exports = { createBriefSkill };
