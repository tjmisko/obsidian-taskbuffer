# Readless incremental updates

Taskbuffer avoids reading a Markdown file again when Obsidian or Taskbuffer
already has its complete text. This matters most on iOS, where a single cold
`Vault.cachedRead()` can cross the native bridge and stall an otherwise tiny
incremental update for seconds.

## The rule

Every incremental update becomes a `FileContentSnapshot` containing the file's
path, basename, mtime, size, full text, and parsed frontmatter. The pure
`fileEntryFromSnapshot()` function parses and enriches that snapshot without
calling Obsidian or touching the filesystem.

There are two normal sources of snapshots:

- `metadataCache.changed(file, data, cache)` supplies authoritative text and
  frontmatter for external edits and newly indexed Markdown files. Events are
  coalesced by path for 150 ms; the latest payload wins.
- Taskbuffer text mutations retain the string returned from their
  `Vault.process()` callback and update the engine from that string immediately.
  Timer and undo/redo operations deduplicate snapshots so each touched file is
  updated once.

Frontmatter mutations use `processFrontMatter()` and wait for the subsequent
metadata event. They do not hand-edit YAML or perform an eager read.

```text
metadata event ─┐
                ├─> FileContentSnapshot ─> pure parse/enrich ─> byFile ─> tasks
text mutation ──┘
```

## The remaining read paths

`readFileEntry()` still calls `cachedRead()` for full startup reconciliation,
manual refresh, and the rename fallback. Obsidian does not emit
`metadataCache.changed` for rename, so rename remains intentionally read-based
until it can be optimized by re-keying the cached entry.

The `vault.create` content listener was removed. Obsidian's metadata event covers
external creates, while Taskbuffer's own inbox creation uses the text it just
constructed.

## Batching and ordering

`PendingFileChanges` keeps the latest snapshot per path and a separate removal
set. A removal beats an older update; a newer update can re-add the path. Draining
swaps in fresh collections, so events arriving while a batch is processed form
the next batch. Removals run before updates, followed by one render and one
debounced persistence cycle.

The engine continues to derive its flat list as regular tasks in file-map order,
followed by synthetic project tasks.

## Diagnostics

With **Debug timing** enabled, each `engine.updateFile` log includes its origin
(`metadata`, `mutation`, or `vault-fallback`), reconciliation wait, vault-read,
parse/enrichment, and flat-list rebuild timings, plus path and task counts. It
never logs note content or task bodies.

Expected normal incremental log fields:

```text
origin: metadata | mutation
vaultReads: 0
vaultReadMs: 0
```

A rename may report `origin: vault-fallback` and `vaultReads: 1`. Full
reconciliation reports aggregate read counts rather than per-file read logs.

Pure coverage lives in `tests/file-entry.test.ts` and
`tests/file-changes.test.ts`.
