# HUD Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** One shared HUD kit; analytics, settings and chat rebuilt on it.

**Architecture:** `src/ui/hud.css` (tokens, components, motion) and `src/ui/hud.js` (helpers) sit beside generated `palette.css`. Each page links them. Analytics is served by the bridge, so the bridge serves the kit files too.

**Tech Stack:** Plain HTML/CSS/JS, SVG, Electron. No libraries.

**Spec:** `docs/superpowers/specs/2026-11-16-hud-frontend-design.md`

## Global Constraints
- No inline `<style>` or `style=""` attributes in chat/settings (CSP `style-src 'self'`); `el.style.x=` from JS is OK.
- Never edit `src/ui/palette.css` (generated).
- Keep every existing element id used by `chat.js`, `settings.js`, `dashboard.js`.
- Text via `textContent`. No outside requests, no libraries.
- Motion off under `prefers-reduced-motion: reduce`.

## Review Focus
- Zero data / empty range in analytics: empty states, no NaN, no broken SVG.
- Narrow width (~375px): no horizontal page scroll.
- Reduced motion: values still show final numbers instantly.
- Bridge missing a kit file: page still readable (falls back to own css vars).
- Settings checkbox → switch: toggling, keyboard focus and `change` events still work.

---

### Task 1: HUD kit
**Files:** Create `src/ui/hud.css`, `src/ui/hud.js`; Test `test/hud-kit.test.js`
**Produces:** `window.HUD = { countUp(el, to, {dur, fmt}), reveal(rootEl), ring(value0to100, {size, cls}) → SVGElement, spark(values, {w,h,cls}) → SVGElement, reduced: boolean }`; CSS classes `.hud-panel .hud-readout .hud-ring .hud-switch .hud-seg .hud-chip .hud-reveal .hud-pulse`, vars `--ease`, `--t-fast/--t-mid/--t-slow`.
- [ ] Test (node:test, file-content): hud.css defines the classes above and a `prefers-reduced-motion` block; hud.js exposes `HUD` with the five members. Run `npm test` → fails.
- [ ] Write both files. `countUp` sets final text immediately when `HUD.reduced`. Run `npm test` → pass.

### Task 2: Serve kit from bridge
**Files:** Modify `src/core/bridge.js:155-168`, `src/main/main.js:527`; Test `test/bridge.test.js`
- [ ] Test: GET `/ai/hud.css`, `/ai/hud.js`, `/ai/palette.css` return 200 with right content-type when `dashboard` given. Fails.
- [ ] Extend `dashboard.files` with `hudCss`, `hudJs`, `palette`; route them. `readDash` reads these three from `src/ui`. Test passes.

### Task 3: Analytics rebuild
**Files:** Modify `src/ui/dashboard/index.html`, `dashboard.css`, `dashboard.js`
**Consumes:** `HUD.*`, bridge routes from Task 2.
- [ ] HUD header (live dot, refresh countdown ring, range segmented control, filters). Same ids kept.
- [ ] Hero tiles: count-up, sparkline from series, state color (ok/warn/crit).
- [ ] Charts: draw-in area/line with glow, hover crosshair readout; ring gauge for skill success; per-service uptime rings + heat strip.
- [ ] Skill table: sticky header, inline success bars, sortable (existing `data-k`).
- [ ] Responsive grid to 375px. Empty state for every chart.
- [ ] Verify in browser pane with fake `/ai/metrics` data and empty data.

### Task 4: Settings rebuild
**Files:** Modify `src/ui/settings.html`, `settings.css`, `settings.js` (nav/search only)
- [ ] Link kit; left section nav with scroll-spy; search filters rows by label text; sections become `.hud-panel`.
- [ ] Checkboxes render as `.hud-switch` (CSS on the existing input, no id changes).
- [ ] Saved indicator flashes with `.hud-pulse`.
- [ ] Verify toggling and keyboard in browser pane.

### Task 5: Chat polish
**Files:** Modify `src/ui/chat.html`, `chat.css`, `chat.js` (class hooks only)
- [ ] Link kit; staggered message entrance; tool-call line becomes a card with status dot; state label uses pulse; rail/input use kit components.
- [ ] Verify streaming caret and boot overlay behave as before.

### Task 6: Verify
- [ ] `npm test` passes. Load all three pages (dark, 375px, reduced motion); fix issues.
