# Kickoff prompt: JARVIS skill groups

Paste this into a fresh Claude Code session opened in `C:\Users\gdani\Projects\Apps\jarvis-core`.

---

You are continuing work on JARVIS (jarvis-core, Electron + Node, tests with `npm test`).

**Read first, in order:**
1. `docs/superpowers/specs/2026-11-10-skill-groups-design.md` (approved design; follow it)
2. `docs/jarvis-prompt-rules.md` (prompt rules and the claim guard you must not break)
3. `src/core/brain/router.js`, `src/core/brain/index.js`, `src/core/tools/registry.js`,
   `src/core/orchestrator.js`, `src/core/brain/guard.js`, `src/core/tools/pc.js`, `src/core/pc/`

**Goal:** replace the flat ~40-tool list with skill groups, load only the relevant groups per turn
(keyword scoring, `more_skills` tool, auto-load recovery), then add new Windows/apps, Files and
Browser skills. Success: tool-spec tokens per deep turn down at least 60%, tool-choice accuracy
not lower, all existing tests green after the migration step.

**How to work:**
- Start with the `superpowers:writing-plans` skill: write
  `docs/superpowers/plans/2026-11-10-skill-groups.md` from the spec (build order in spec section 8),
  then stop and show it to me. Do not write product code until I approve the plan and the
  execution method.
- Then execute with TDD, one build step at a time, `npm test` green after each, one commit per step.
- Step 1 must be a pure migration: tool names, descriptions, params and `risk` identical before
  and after (add a test that proves it).
- Keep every safety rule: `risk: 'confirm'` confirmed from the user's own words in code, tainted
  turns cannot start confirm tools, file skills use `pc/paths.js`, the action log and the undo
  journal.
- Browser group is off by default behind a settings switch; the extension keeps a fixed command
  switch (JARVIS never sends code).
- Branch: create `feat/skill-groups` from the current work; the working tree has uncommitted
  edits in `src/core/media/rank.js` and `test/ytmusic.test.js` that are not yours; leave them out
  of your commits.
- Real-PC checks (window moves, screenshots, clipboard, Wi-Fi) go into a manual checklist file
  like `docs/superpowers/plans/2026-11-10-pc-actions-checklist.md`; do not claim them verified.
- Report outcomes plainly, including failing tests and anything skipped.
