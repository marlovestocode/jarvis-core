# Cortex Core (A) — manual checklist

Things the automated tests and the bench cannot prove. None of these is verified yet; tick them only after doing them on the real PC.

## Needs your yes first

- [ ] **Download the embedding model.** `ollama pull nomic-embed-text` (~270 MB). Not installed as of 2026-11-11.
- [ ] **Real recall-quality check** (after the download, with the GPU free or JARVIS stopped):
  `node scripts/cortex-quality.js --embedder ollama --dim 256` → must print `GATE PASS` (overlap@10 ≥ 0.95 between int8/256 and full float32).
  If it fails, rerun with `--dim 384`, then `--dim 512`, and use the smallest dim that passes (spec §6.3).

## Real PC, real app

- [ ] Embedder runs on CPU: while JARVIS's chat model is loaded, run a few embeds and confirm VRAM use does not change (Task Manager → GPU memory, or `ollama ps` shows the embed model at 100% CPU).
- [ ] Boot inside Electron 45 (Node 24 / SQLite 3.53): open a cortex file from the app's main process and check `health().quickCheck === 'ok'` (wave 1 does the wiring; check then).
- [ ] The `ExperimentalWarning: SQLite is an experimental feature` line: decide whether to hide it in `jarvis.log` (it prints once per process).
- [ ] Backups: after a night with JARVIS idle, `%APPDATA%\jarvis-core` holds at most 3 `cortex.backup-*.db` files.
- [ ] Corrupt-file recovery on the real data folder: copy the folder, garble `cortex.db` in the copy, start with `JARVIS_DATA_DIR` pointing at the copy, see `broken\` and a restored db.

## Bench on the author's PC

- [ ] `node --expose-gc scripts/cortex-bench.js` with JARVIS stopped (the numbers in the stage report were taken with JARVIS running in the background).
