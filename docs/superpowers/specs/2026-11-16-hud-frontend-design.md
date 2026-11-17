# HUD frontend modernization — design

## Intent
Make analytics, settings and chat feel like one machine. What draws the eye is the cohesion: shared look, shared motion, shared state colors. Not three restyled pages.

## Goals
- One shared HUD kit (`src/ui/hud.css`, `src/ui/hud.js`) used by chat, settings and analytics.
- Analytics: high-tech, detailed, easy to read, animated, responsive.
- Settings: sectioned nav, switches, cards, search. Chat: smoother messages, streaming, tool cards.
- One motion language: same easing, durations, stagger, glow pulse everywhere.
- `prefers-reduced-motion` turns motion off cleanly.

## Non-goals
- No framework, no libraries, no outside requests.
- No logic changes in `chat.js` / `settings.js` / `dashboard.js` data handling beyond what markup needs.
- No live cross-page links (orb → analytics pulse, health dots in settings). Possible step 2 ("C").

## Constraints
- Chat/settings CSP: `default-src 'self'; style-src 'self'` — no inline `<style>`/`style=""` attributes; `el.style.x =` from JS is fine.
- Analytics is served by the bridge (`src/core/bridge.js`, files passed from `src/main/main.js`) and opened in the user's browser. Only html/js/css are served today → add `hud.css`, `hud.js`, `palette.css` routes + file reads.
- `palette.css` is GENERATED — do not edit. Kit builds on its variables (`--accent`, `--gold`, `--crit`, `--a-*`, fonts).
- Keep existing element ids that JS and tests rely on.
- Analytics numbers stay local, text set with `textContent`.

## Approaches
- **A (chosen):** shared kit, rebuild all three on it.
- B: restyle each page alone — pages drift, rejected.
- C: A plus live IPC links — later step.

## Design
- **hud.css:** tokens (motion, easing, radii, glow), panel with corner brackets and scan-line edge, readout/gauge/ring/switch/segmented/chip/table components, state colors (ok=cyan, warn=gold, crit=red), reveal/stagger/glow-pulse keyframes.
- **hud.js:** `countUp`, `reveal` (staggered entrance via IntersectionObserver-free class toggles), `ring` (SVG progress), `spark` (mini sparkline), pulse-dot helper.
- **Analytics:** HUD header with orb-style live dot and refresh countdown; hero tiles with count-up + sparklines; area/line charts that draw in with glow and hover crosshair readout; ring gauges for skill success and per-service uptime; heat strip per connection; skill table with inline bars and sticky header; responsive grid down to phone width.
- **Settings:** left section nav + scroll-spy, search filter, switch toggles replace checkboxes (same `<input type=checkbox>` underneath), card per section, saved flash.
- **Chat:** staggered message entrance, tool-call cards, cleaner streaming caret, polished rail/input; panel uses kit components.

## Left to builder
Exact spacing, easing values, chart tooltip details, nav icon style.

## Verification
Run `npm test`; load all three pages in the browser pane (dark, narrow width, reduced motion).
