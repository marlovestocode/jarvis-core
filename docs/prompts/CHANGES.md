# Prompt changes, 2026-11-12

Full generated prompts for the same inputs (text chat, voice, quick voice chat; nine tools in scope) are in
[system-prompt.before.txt](system-prompt.before.txt) and [system-prompt.after.txt](system-prompt.after.txt). Regenerate with the
script in the audit notes (`systemPrompt()` from `src/core/brain/prompt.js`, tools from `test/helpers/tool-deps.js`). The prompt is built in code, not read from files:
`src/core/brain/prompt.js` (system and quick-chat prompts), `src/core/voice/dialect.js` (character and diction), the `hint` of each tool, the
nudges at the top of `src/core/orchestrator.js`, and the argument error text in `src/core/tools/args.js`.

| # | Problem (audit id) | Before | After | Test |
|---|---|---|---|---|
| 1 | Contradiction: exact figures vs "round" (P-1) | Everywhere: "Quote tool results with at least 5 significant figures… round only if the user asks". Voice rule: "Round numbers sensibly". | The 5-figure rule is for typed chat only. Voice: "Say numbers the way a person would ("about 21 degrees", not 21.4 or 21.437), and give exact figures only when asked." | `prompt-tools: the dialect is chosen in settings…` |
| 2 | Contradiction in the diction rule (P-2) | "grammatically impeccable, the English of a well-read Oxford or Harvard graduate… Formal but not stiff" and, in the same paragraph, "Contractions are fine… but keep the register formal"; the Character line said "never casual". | British formal: "formal but natural… Use contractions where a person would say them aloud; keep the formality in word choice, not by avoiding contractions." "Never casual" removed. | `prompt: JARVIS has a voice of his own…` |
| 3 | Dialect hard-coded (P-2, SP-1) | One British-butler paragraph in `prompt.js`, plus a matching rewrite table in `speech-text.js`. | `config.speech.dialect` (`british-formal` default, `neutral`, `casual`). The prompt and the spoken-text rules both read it from `dialect.js`, so they cannot disagree. | `prompt: the dialect is chosen…`, `speech: the dialect decides the register…` |
| 4 | No guidance to plan, check or ask (P-3) | Only the "Meaning" rule (ask when two readings are plausible). | New "Method" rule (when tools are in scope): decide the steps, check each tool result, re-read the request before answering, every figure from a tool or the user, look in notes and the Media line before asking, ask one short question only when a missing detail changes what he does, say what a result says changed. | `prompt: method (plan, check, ask)…` |
| 5 | Weak skill match was invisible to the model (S-3) | none | When no skill group matched, "No skill matched this request clearly. If it asks you to do something and it is unclear what to act on, ask one short question instead of guessing a tool; if it is a question or chat, just answer it." | same test |
| 6 | Hand-typed confirm-tool list (P-4) | "PC actions: close_app, end_unresponsive_app, wifi_set, … only ASK first", all eleven names, whether or not they were in scope. | Built from the tools in scope that carry `risk: 'confirm'`. | `prompt: the "only ASK first" list…` |
| 7 | Varied sentence length was not asked for | none | Every dialect: "Vary sentence length: mix short sentences with one longer one, and never three of the same length in a row." | dialect text |
| 8 | A made-up figure could reach the answer | none | After tools ran, a text answer with a precise figure found in no tool result or message is retracted once and asked again: "Your reply gave figures that appear in no tool result or message: …" (`brain/guard.js: ungroundedFigures`). | `orchestrator: after tools, an answer with an untraceable figure…` |
| 9 | Bad tool arguments were left to the tool or the model | none | The runner refuses them before the tool runs and says what it takes: "Error: <tool> was not run: <problem>. It takes: …. Call it again with arguments that fit, or ask the user for what is missing; do not say it was done." | `args: harmless mismatches are fixed…` |

Not changed on purpose: the "Actions", "Hearing", "Titles are not requests", "Abilities" and "You are J.A.R.V.I.S." rules, the secret-picks and music-picking
rules, and the fetched-text rules. They came from failures in saved chats (see `docs/jarvis-prompt-rules.md`) and nothing I read contradicts them.
The two rule files that still describe the old wording are `docs/jarvis-prompt-rules.md` (the voice diction paragraph) and `docs/audit-2026-11-10.md` (open items 1 and 2, now fixed).
