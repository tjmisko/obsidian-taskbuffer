# Incremental scan & sub-100ms cold start — design

## Problem

The view builds its task list by scanning the **entire** vault on every refresh:
`scanVault` reads all markdown files via `cachedRead`, splits and parses every
line, then enriches from frontmatter. Measured on a 5,993-file vault:

| Phase | Cold (first load) | Warm (cache hot) |
|---|---|---|
| `engine.refresh` (scanVault) | **7,075 ms** | 130–220 ms |
| `render` (post-virtualization) | ~5 ms | ~5 ms |

Render is solved (virtualization). The scan is the remaining cost, and it runs
at startup **and** (debounced) after every verb and every file change.

### Key measurements

- 5,993 markdown files; **only 615 contain an open task** (`- [ ]`). ~90% of the
  files read during a scan contribute nothing.
- 9,102 open-task lines — the real working set.

### Key invariant (verified)

Enrichment in `frontmatter.ts` is **entirely per-file**: tag inheritance,
completion filtering, due inheritance, and synthetic project tasks each read
only `task.filePath`'s own frontmatter. There is **no cross-file coupling**.
Therefore re-parsing a single changed file and splicing it into the cache is
*correct*, not approximate.

## Strategy — three composing pillars

### A. Persisted snapshot (instant cold paint)

Persist the urgent slice of the task list and render it *before* any scan runs.

- **Scope:** all open **dated** tasks + a cap (~200) of open **undated** tasks.
  The near-horizon dated tasks are what the user actually sees first; the large
  `Someday` tail is deferred to the background reconcile (Pillar B).
- **Storage:** `data.json` (already loaded into memory by `loadData()` at plugin
  load, so the snapshot is available with zero extra I/O). Capping keeps it to
  tens of KB — important because the vault is under `obsidian-git`; a multi-MB
  cache would churn the repo. (Full-snapshot + mtime-incremental reconcile is a
  possible future variant; rejected now for git-churn/size reasons.)
- **Invalidation:** a `settingsHash` over the parse-affecting settings (sources,
  horizons, weekStart, overlap, formats, frontmatter, strict). If it differs from
  the snapshot's, ignore the snapshot and force a full reconcile.

Cold-paint budget: parse snapshot JSON (~5 ms for the capped slice) →
`buildSections` (~6 ms) → paint window (~5 ms) = **well under 100 ms**.

### B. Metadata-filtered reconcile (cheap background correctness)

After `onLayoutReady`, reconcile the snapshot against the vault — but only read
the files Obsidian's **already-cached** `metadataCache.listItems` says contain an
open task (plus files whose frontmatter makes them a `project`). ~615 reads
instead of 5,992. Runs in the background; the user already sees the snapshot.

Candidate selection uses no disk I/O (metadata cache is in memory):

```
candidate(file) :=
     some listItem.task ∈ openChars      // openChars derived from formats.checkbox.open
  OR isProjectFile(frontmatter)          // tags includes "project" AND has a due
  OR metadataCache has no entry yet      // not parsed → read to be safe
```

### C. Per-file incremental updates (no more full rescans)

Replace the debounced full-vault rescan with a per-file update:

- `metadataCache.on("changed", file)` → re-parse **only that file**, re-enrich
  from its frontmatter, splice into the cache, rebuild the flat list (~1 ms),
  re-render. Covers content edits, frontmatter edits, and a file *gaining* a
  project task.
- `vault.on("delete"/"rename")` → drop / re-key that file's entry.
- **Verbs** (`complete`, `defer`, timer, date-shift, `create`, …) currently call
  `refresh()` (full scan) after writing. They switch to `updateFile(path)` for
  the one file they touched → verbs become instant.

## Data-model change (the spine)

`TaskEngine` stops holding a flat `Task[]` as the source of truth and instead
holds a per-file map; the flat list is derived:

```ts
interface FileEntry {
  path: string;
  mtime: number;          // TFile.stat.mtime
  enriched: Task[];       // per-file enrichment output (incl. its project task)
}

class TaskEngine {
  private byFile = new Map<string, FileEntry>();
  tasks: Task[] = [];                       // derived: concat of byFile.*.enriched
  hydrate(snapshotTasks: Task[]): void;     // Pillar A — paint without byFile
  reconcile(): Promise<void>;               // Pillar B — read candidates, fill byFile
  updateFile(path): Promise<void>;          // Pillar C — re-parse one file
  removeFile(path): void;                   // Pillar C — delete/rename
  snapshot(): Task[];                       // dated + capped undated, for persistence
}
```

`rebuildFlat()` (concat of ~9k objects, <1 ms) runs after any mutation.

## Module-by-module changes

- **`frontmatter.ts`** — extract `enrichFileTasks(raw, meta, settings): Task[]`
  (the four passes + project-task append, for one file). Reimplement the existing
  `enrichTasks` as a thin loop over files calling it, so current tests/behavior
  are unchanged.
- **`scan.ts`** — add pure `selectCandidates(fileInfos)` (testable without
  Obsidian: takes `{path, listItems, frontmatter}[]`, returns candidate paths);
  add `readFileEntry(app, file, ctx): Promise<FileEntry>`; refactor `scanVault`
  to read candidates only.
- **`engine.ts`** — the data-model change above; verbs call `updateFile` instead
  of `refresh`.
- **`main.ts`** — load+hydrate snapshot in `loadState`; `reconcile()` in
  `onLayoutReady`; swap the debounced full-scan event wiring for per-file
  handlers; debounced `writeSnapshot()`.
- **`config.ts`** — `settingsHash(settings)` helper + the persisted shape.

## Phasing (each phase ships green)

1. **Per-file refactor** — `enrichFileTasks` + engine `byFile`/`rebuildFlat`;
   verbs → `updateFile`. No behavior change; existing 124 tests stay green, add
   `enrichFileTasks` parity tests.
2. **Metadata-filtered candidates (B)** — `selectCandidates`; reconcile reads
   ~615 files. Unit-test `selectCandidates` against metadata-shaped fixtures.
3. **Snapshot (A)** — `snapshot()`/`hydrate()`, persistence, `settingsHash`
   invalidation, cold-paint flow. Tests for trim/hydrate + invalidation.
4. **Incremental wiring (C)** — per-file event handlers replace the debounced
   full rescan; `updateFile`/`removeFile`/rename. Verify via the perf logs.

## Testing

Obsidian-touching glue (the `App`/`Vault`/`metadataCache` calls) stays thin;
the decisions are pushed into pure, vitest-able helpers: `enrichFileTasks`,
`selectCandidates`, snapshot trim/hydrate, `settingsHash`. Engine orchestration
is verified against the `[taskbuffer]` perf logs (cold paint, reconcile,
per-file update should all show their new budgets).

## Risks / edge cases

- **metadataCache not ready** at reconcile → `getFileCache` is null; include the
  file (read it) to be safe. Rare after `onLayoutReady`.
- **Custom checkbox glyph** → derive `openChars` from `formats.checkbox.open`;
  fall back to "any task list item" if it can't be parsed.
- **External edits while Obsidian closed** → the capped snapshot always triggers
  a full candidate reconcile on cold start, so they're caught within ~1 s.
- **Project-only files** (no task lines, `project` frontmatter) → covered by the
  `isProjectFile` candidate branch and by `enrichFileTasks` appending the
  synthetic task even when `raw` is empty.
- **Event storms** (sync writing many files) → batch `updateFile` per path, then
  a single debounced render + snapshot write.
- **Strict-mode date errors** were surfaced from the full scan; with incremental
  updates they surface per changed file. Acceptable; low priority.
