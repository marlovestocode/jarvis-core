# The wallpaper's neural lattice is the cortex

**Goal.** The background lattice stops being decoration. Its nodes are JARVIS's real memory nodes, its links are real links, and it fires like neurons when memory is used. The existing per-token sparks and tool limbs stay.

## What is shown
- **Nodes:** the most important and most used active cortex nodes (default 360, up to 800). Tinted by kind, grouped in a lobe per kind, important ones on the inner shell, brighter the more they are used. Linked memories are pulled together by a fixed, deterministic relaxation, so the same memory gives the same picture.
- **Links:** real links among those nodes; brightness is the link's effective weight (decayed to now). Strong links stand out, weak ones are a haze.
- **Firing** (bus type `brain`, ids only):
  - `recall` a lookup: its seed nodes light at once, then pulses travel along the links the spreading activation actually followed, hop by hop; the packed answer items stay lit. This is the real path, not an animation.
  - `write` something was learned or changed (batched; an import of thousands is one event): gold.
  - `use` items used together after a turn, whose links grew: soft glow, pulses along the links that exist.
- **Labels:** a few words next to the nodes that are lit (first line of the node text, 28 characters).

## Core (`jarvis-core`)
- `cortex/brainview.js` `view({max, maxEdges, focus})` is the shape only: id, kind, importance, uses, link weights. No text. `labels(ids)` returns the few words.
- `cortex/activity.js` turns recall, writes and reinforcement into `brain` events. Rate-limited per op (120 ms), capped (48 ids, 120 trail links), writes batched over 150 ms. A listener error never reaches the cortex.
- `cortex/recall.js` reports its seeds, the followed links and the packed items through an optional `onActivity` callback.
- Bridge: `GET /ai/brain[?max=&focus=]` (shape, open like the stream because it has no words) and `GET /ai/brain/labels?ids=`.

## Privacy of the labels
The event stream is readable by any page on localhost, and by a sandboxed frame on any site (it sends `Origin: null`). So words never go on the stream, and the label route is stricter:
- only while `cortex.wallpaperLabels` is on (default on, a setting you can turn off);
- only to a request with **no Origin** or `file://` (how the wallpaper's own page asks). `http://localhost:*`, `null` and every other origin get 403;
- at most 24 ids per request, 28 characters each.

If the wallpaper host sends `Origin: null`, labels are refused and the lattice still works with shape and firing only (it stops asking for five minutes). A local program that is not a web page can still read the route; it could read `cortex.db` directly in that case.

## Wallpaper (`jarvis-desktop`)
- `lattice-model.js` `setGraph()` replaces the generated lattice (fewer than 8 nodes keeps it). `event({type:'brain'})` lights nodes and sends pulses; unknown ids are reported by `wantIds()` and the page fetches a graph that includes them (at most every 8 s; a refresh every 3 minutes). Token sparks walk real links.
- `lattice.js` draws it: per-node and per-link colours, a glow layer for lit nodes, pulse trails.
- `ai-link.js` `brain()` and `labels()`; `?demo=ai-live` plays a made-up memory with recalls, a write and a use.
- `app.js` keeps the graph fresh and places the labels.

## Tests
Core: shape has no text, ordering, effective weights, archived nodes out, labels capped, recall trail and seeds, reinforce and write events, rate limits, the label origin gate (no Origin, `file://`, `null`, localhost, foreign, switched off). Wallpaper: graph replaces the lattice, stable placement, dropped dangling links, sparks on real nodes, recall hop timing, write and use, unknown ids, pulse cap, relaxation pulls links closer and is deterministic.
