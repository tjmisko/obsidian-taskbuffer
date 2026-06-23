# Incremental scan & sub-100ms cold start — 2026-06-23

Branch: `feat/incremental-scan` (off `main`). All gates green: typecheck, lint,
164 tests, production build. Design in `docs/INCREMENTAL_SCAN.md`.

## Completed
All four phases shipped, each an atomic green commit:
- **Phase 0** — baseline: branch + committed the existing virtualized-view / perf
  work and the design docs.
- **Phase 1** (`refactor:`) — engine holds `byFile: Map<path, FileEntry>`; flat
  `tasks` derived via `rebuildFlat`. Extracted `enrichFileTasks`/`projectTaskFor`;
  `enrichTasks` is now a thin loop (byte-for-byte parity). Verbs call
  `updateFile(path)` not `refresh()`.
- **Phase 2** (`perf:`) — pure `candidates.ts`; `scanVault` reads only
  metadata-cache candidates (open-glyph / project / uncached), ~hundreds not ~6k.
- **Phase 3** (`feat:`) — `snapshot.ts` + `settingsHash`; hydrate-and-paint on
  load before any scan, reconcile in background, debounced snapshot write.
- **Phase 4** (`perf:`) — per-file event wiring (changed/create/delete/rename)
  batched through dirty/removed sets; full rescan removed.
- **Review fix** (`fix:`) — single-flight `reconcile` (no cold-start race);
  empty-bracket open-glyph falls back to any-task.

## Decisions
- Flat-list ordering kept identical (regulars→projects split) though `rows.ts`
  sorts totally, so the view is order-independent — belt and suspenders.
- Candidate under-inclusion is the only real risk; everything errs inclusive
  (uncached → read; unparseable glyph → any task).

## Blockers
None.

## Next
- Manual verification in Obsidian on the 5,993-file vault: confirm perf logs show
  hydrate+paint <100ms before reconcile, reconcile reads ~615 files, and edits
  log `engine.updateFile` (~ms) — never `scanVault`.
- Then open a PR to `main`.
