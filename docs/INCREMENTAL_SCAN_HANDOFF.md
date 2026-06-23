# Handoff — incremental scan & sub-100ms cold start

This document prepares a fresh agent to execute the plan in
[`INCREMENTAL_SCAN.md`](./INCREMENTAL_SCAN.md). Read that design doc first; this
file is the **execution playbook** — sequencing, definitions of done, tests,
commands, and guardrails. Work through the phases in order; each ends green and
committed.

---

## Orient first (do not write code until done)

Read, in order:
1. `docs/INCREMENTAL_SCAN.md` — the design (problem, measurements, the three
   pillars A/B/C, the per-file invariant, risks).
2. This file.
3. The code you will change: `src/engine.ts`, `src/scan.ts`, `src/frontmatter.ts`,
   `src/main.ts`, `src/config.ts`, and `src/view.ts` (consumer only).
4. `AGENTS.md` (build/lint/test) and `docs/PARITY.md` (behavior parity rules).

Then state, in your own words: the current phase, what's done vs. pending, and
the locked decisions below. Confirm before implementing.

### Locked decisions (do not relitigate)
- **Virtualization is already shipped** in `view.ts` (uniform single-line rows,
  pinned detail strip, `?` help, two view types). This effort is **only the
  scan/cache layer** behind it.
- **Capped snapshot in `data.json`** (all open dated + first ~200 open undated).
  Not a full snapshot, not a separate cache file — the vault is under
  `obsidian-git`, so the persisted blob must stay small.
- **Per-file enrichment is correct** (verified): `frontmatter.ts` reads only each
  task's own file's frontmatter. A single-file re-parse cannot desync the rest.
- **Metadata-filtered candidates**: only ~615 of 5,993 files have open tasks.
  Use `metadataCache.listItems` (already in memory) to pick them — no disk I/O to
  decide candidacy.

---

## Baseline (Phase 0)

The working tree currently holds this session's **completed, green** UI work
(compact virtualized views, marker log, perf instrumentation) plus these docs,
all uncommitted on `main`.

1. `git switch -c feat/incremental-scan`
2. Commit the existing work as the baseline, e.g. two atomic commits:
   - `feat: virtualized keyboard task views + timing instrumentation`
     (`src/view.ts`, `styles.css`, `src/perf.ts`, `src/render/markers.ts`,
     `tests/markers.test.ts`, and the perf/setting wiring in `src/main.ts`,
     `src/engine.ts`, `src/config.ts`, `src/settings.ts`)
   - `docs: incremental-scan design and handoff`
     (`docs/INCREMENTAL_SCAN.md`, `docs/INCREMENTAL_SCAN_HANDOFF.md`)
3. Confirm green: `npm run typecheck && npm run lint && npm test`.

Do all phase work on `feat/incremental-scan`.

---

## Commands (run every phase)

```bash
npm run typecheck      # tsc -noEmit
npm run lint           # eslint (obsidianmd rules — must be clean)
npm test               # vitest run (124 tests today; keep green, add per phase)
npm run dev            # esbuild watch; reload plugin in Obsidian to test (no Hot-Reload)
```

Verify budgets from the `[taskbuffer]` console lines (the `debugTiming` setting
is on by default).

---

## Guardrails

- **Pure modules stay Obsidian-free.** `parse/`, `frontmatter.ts`, `dates.ts`,
  `horizon.ts`, `render/`, `state.ts`, `perf.ts`, and any new *logic* helpers
  MUST NOT `import "obsidian"` — they run under vitest. Obsidian glue lives only
  in `main.ts`, `view.ts`, `engine.ts`, `scan.ts`, `settings.ts`, `modals.ts`.
- **Parity is load-bearing.** Do not change observable parsing, enrichment order,
  or bucketing. `enrichTasks` must keep producing identical output (its tests
  must stay green). See the header comment in `frontmatter.ts`.
- **Push decisions into pure helpers** (`enrichFileTasks`, `selectCandidates`,
  `settingsHash`, snapshot trim) so they're unit-tested without Obsidian; keep
  the `App`/`Vault`/`metadataCache` calls thin.
- **Conventional, atomic commits**, one logical change each. Branch, never `main`.
- Don't silently weaken coverage: if `listItem.task` can't identify open tasks,
  fall back to "any task list item" and `log()` it — never just read fewer files
  and hope.

---

## Phase 1 — Per-file cache in the engine (no behavior change)

**Goal.** Replace the engine's flat `tasks: Task[]` source-of-truth with a
per-file map; derive the flat list. Extract per-file enrichment. Verbs update one
file instead of rescanning.

**Files.** `frontmatter.ts`, `engine.ts`, `scan.ts`, tests.

**Do.**
- `frontmatter.ts`: extract `enrichFileTasks(raw: Task[], meta: FileMeta, settings): Task[]`
  (passes 1–3: tag inherit, completion filter, due inherit) and
  `projectTaskFor(meta: FileMeta, settings): Task | null` (pass 4; export the
  existing `buildProjectTask`). Reimplement `enrichTasks` as: concat all files'
  `enrichFileTasks`, **then** append all `projectTaskFor` — preserving the current
  "regular tasks, then project tasks" order so existing tests pass byte-for-byte.
- `scan.ts`: add `readFileEntry(app, file, ctx, settings): Promise<FileEntry>`
  (`cachedRead` → parse lines → `FileMeta` from `metadataCache` → enrich → 
  `{ path, mtime: file.stat.mtime, enriched }`).
- `engine.ts`: hold `private byFile = new Map<string, FileEntry>()`; `tasks`
  becomes derived via `rebuildFlat()` (`[...byFile.values()].flatMap(e => e.enriched)`).
  `refresh()` rebuilds `byFile` from a full scan (still all source files this
  phase). Add `updateFile(path)` (re-read one file; delete entry if it yields no
  enriched tasks) and `removeFile(path)`. **Verbs** (`complete`, `check`, `defer`,
  `markIrrelevant`, `unsetIrrelevant`, timer start/stop/complete, `shiftDate`,
  `setDateToday`, `create`) call `updateFile(path)` instead of `refresh()`.

**Done when.** typecheck + lint + all existing tests green; the view is visually
identical; a verb shows `updateFile` in the perf log, not a full `scanVault`.

**Tests.** Add `enrichFileTasks` parity: one file in isolation equals its slice
of `enrichTasks`. Keep all 124 green.

**Commit.** `refactor: per-file task cache in engine (enables incremental scan)`

---

## Phase 2 — Metadata-filtered candidates (Pillar B)

**Goal.** The scan reads only files that have an open task or a project
frontmatter — ~615, not 5,992.

**Files.** `scan.ts` (+ pure `selectCandidates`), `engine.ts` (refresh uses
candidates), tests.

**Do.**
- Pure `selectCandidates(infos, openChars): string[]` where each `info` is plain
  data `{ path, taskChars: string[], frontmatter, cached: boolean }`. Candidate
  iff `!cached` **OR** `taskChars` intersects `openChars` **OR**
  `isProjectFile(frontmatter)` (tags include `"project"` and a due exists).
- `openCharsFromSettings(settings)`: the char(s) inside `formats.checkbox.open`
  (e.g. `- [ ]` → `" "`). Fall back to "any task item" if unparseable.
- Obsidian glue `candidateFiles(app, settings): TFile[]`: build `infos` from
  `metadataCache.getFileCache` (`listItems.map(li => li.task)`, `frontmatter`,
  `cached`), run `selectCandidates`, resolve to `TFile`s within `sources`.
- `engine.refresh()` reads `candidateFiles` only.

**Done when.** Perf log: `scanVault` drops sharply and `{tasks}` is unchanged
(no tasks lost). Manually confirm against the vault that `listItem.task` reports
`" "` for the open glyph, and that a project-only file still appears.

**Tests.** `selectCandidates` fixtures: open task, done-only, project-only,
uncached, custom open glyph.

**Commit.** `perf: scan only files with open tasks via metadata cache`

---

## Phase 3 — Persisted snapshot (Pillar A)

**Goal.** Cold paint <100ms by rendering a persisted slice before any scan.

**Files.** `config.ts` (`settingsHash` + persisted shape), `engine.ts`
(`snapshot`/`hydrate`), `main.ts` (load/hydrate/persist), tests.

**Do.**
- `config.ts`: `settingsHash(settings): string` over parse-affecting settings only
  (`sources`, `horizons`, `horizonsOverlap`, `weekStart`, `strict`, `formats`,
  `frontmatter`). Stable (sorted-key) serialization → small hash. Pure.
- `engine.snapshot(): Task[]` = open tasks, all dated + first `SNAPSHOT_UNDATED_CAP`
  (~200) undated. `engine.hydrate(tasks)` sets `this.tasks` directly (byFile stays
  empty until reconcile). Guard: if a verb fires while only-hydrated, `await`
  reconcile first so `rebuildFlat` doesn't wipe the list.
- `PersistedData`: add `snapshot?: { version: 1; settingsHash: string; tasks: Task[] }`.
- `main.loadState`: load snapshot; if `settingsHash` matches, `engine.hydrate`.
  `onLayoutReady`: `await engine.reconcile()` → render → debounced `writeSnapshot`.

**Done when.** Perf log shows hydrate+render before reconcile, cold paint <100ms;
changing a parse-affecting setting invalidates the snapshot (forces full rescan).

**Tests.** `settingsHash` stability + sensitivity; snapshot cap (all dated kept,
undated capped); `hydrate` sets `tasks`.

**Commit.** `feat: persist task snapshot for instant cold start`

---

## Phase 4 — Incremental event wiring (Pillar C)

**Goal.** Replace the debounced full-vault rescan with per-file updates.

**Files.** `main.ts` (event wiring), `engine.ts` (already has `updateFile`/`removeFile`).

**Do.**
- Remove the `onLayoutReady` full-scan handlers. Wire: `metadataCache.on("changed", file)`
  → enqueue `updateFile`; `vault.on("delete")` → `removeFile`; `vault.on("rename")`
  → `removeFile(old)` + `updateFile(new)`; `vault.on("create")` → `updateFile`.
- Batch changed paths in a `Set`, debounce ~150ms, then `updateFile` each → one
  `renderViews` → debounced `writeSnapshot`. Keep the manual `refresh` command.

**Done when.** Editing a file shows only `updateFile` (~ms) in the log, never a
full `scanVault`; deletes/renames reflect correctly; verbs are instant.

**Commit.** `perf: incremental per-file updates replace full rescan`

---

## Whole-effort definition of done
- Cold paint <100ms (hydrate path); background reconcile reads ~615 files.
- Edits and verbs trigger per-file updates, never a full scan.
- typecheck + lint + all tests green; the view behaves exactly as before.
- Update the phase checklist below and write a short session note
  (`docs/session-notes/YYYY-MM-DD HH:mm - incremental-scan.md`, <300 words:
  Completed / In Progress / Decisions / Blockers / Next).

## Phase checklist
- [x] Phase 0 — branch + baseline commits, green
- [x] Phase 1 — per-file cache, no behavior change
- [x] Phase 2 — metadata-filtered candidates (~615 reads)
- [x] Phase 3 — persisted snapshot, cold paint <100ms
- [x] Phase 4 — incremental event wiring
