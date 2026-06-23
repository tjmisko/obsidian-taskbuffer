# Task Buffer — parity design & build notes

This plugin ports **taskbuffer.nvim** (canonical pure-Lua impl at
`~/Projects/taskbuffer.nvim`, branch `main`) to an Obsidian plugin, aiming for
feature parity. This doc is the working contract so the build survives across
sessions.

## Decisions (locked)

- **View**: a custom `ItemView` (DOM + CSS grid columns), not a generated text
  file. Rows show *parsed, separated fields* (date · time · duration · body ·
  tags) with a **native Obsidian checkbox**, never the raw `(@[[…]])` / `<30m>`
  / `::marker` markup. Same section order & "vibe" as the nvim taskfile.
- **Task syntax (read & write)**: ported verbatim from taskbuffer.nvim so the
  same notes work in nvim and Obsidian. Configurable wrappers/checkboxes/
  strftime/marker-prefix.
- **Scope**: full parity in one push (view + all write verbs + timer + undo/redo
  + full settings + tests + release).

## Neovim → Obsidian translation

| nvim | Obsidian |
|---|---|
| `rg`/`grep` scan of dirs | `Vault.getMarkdownFiles()` filtered by `sources`; `metadataCache` for frontmatter; `Vault.cachedRead` for line text |
| `.taskfile` read-only buffer + conceal | custom `ItemView`, DOM rows, CSS grid, theme variables |
| Neovim keymaps (`<leader>t*`) | Obsidian **commands (no default hotkeys)** + an in-view keyboard `Scope` |
| `gf` to source | click row / command → `workspace.getLeaf().openFile()` + scroll to line |
| write verbs (in-situ) | `Vault.process()` (background) / `Editor` (open file) / `FileManager.processFrontMatter` (FM due) |
| timer state `~/.local/state/task/current_task` (TSV) | `Plugin.loadData()/saveData()` (mobile-safe, off-FS) |
| undo/redo stack | in-memory stack, ported |

## Canonical task syntax

```
- [ ] Body text <30m> #tag (@[[2026-02-17]] 16:00) ::start [[2026-02-17]] 15:17 ::complete [[…]] 17:19
```
- **checkbox/status** (line prefix): `- [ ]`→open, `- [x]`→done, `- [-]`→irrelevant (configurable; literal longest-first match). Only `open` shows in the view.
- **duration** `<Nm>` (hardcoded; configurable `formats.duration` was dead config in the reference and is intentionally dropped here).
- **tags** `#word` (prefix configurable; `[A-Za-z_][\w-]*`).
- **due date** inside `dateWrapper` (3-el `[open,mid,close]` → time between mid/close; 2-el `[open,close]` → time before close). Wikilink alias `[[id|DATE]]` and path `[[dir/DATE]]` stripped. strftime-configurable.
- **due time** verbatim string; 12h `%I:%M %p` with flexible AM/PM space.
- **markers** `::kind [[DATE]] [TIME]` — always literal `[[ ]]`; raw dates kept. `::original` is date-only.
- Internal due-date repr: **local-noon epoch ms** (`null` = undated); DST-safe, comparable.

## Frontmatter enrichment (order is load-bearing)

1. tag inheritance (FM `tags` LIST only; scalar ignored) → union, FM after inline.
2. completion filtering: file with `due` AND status ∈ done_values drops its *undated* tasks. **Before** inherit.
3. due inheritance: undated tasks inherit file FM `due` (+time); inline wins; `require_tags` all-of gate.
4. project tasks: file tagged `project` + FM `due` + non-done → synthetic open task (body = basename, line 1, `sortLast`).

## Horizons

Defaults, in order: Overdue(`past`), Today(`0`), Tomorrow(`1`), This Week(`2`),
This Month(`8`), This Year(`31d`), Far Off(`366d`), Someday(undated).
`after` = int day-offset | duration (`d`/`w`/`m`=30/`y`=365) | calendar keyword
(`past`, `yesterday`, `end_of_week` [respects `weekStart`], `end_of_month`,
`end_of_quarter`, `end_of_year`). Overlap modes: `sorted` (default, monotonic
forward scan), `first_match`, `narrowest`. Empty buckets skipped; undated last.
Sort within: dated `date→path→!sortLast→line`; undated `path→sortLast→line`.

## Write-verb semantics (byte-exact to reference)

- marker format: `<prefix><kind> [[DATE]] TIME ` (trailing space), configured date/time formats.
- `complete-at`: append `::complete` **then** flip open→done.
- `defer`: if no `::original`, copy inline due as `::original [[date]]` (date only), then append `::deferral`; due date itself unchanged.
- `check`: flip open→done, no marker.
- `irrelevant`: flip open→irrelevant **then** append `::irrelevant`.
- `unset`: remove last `::irrelevant`, flip irrelevant→open.
- `start`/`stop`/`complete` (timer): append marker, manage `current_task` state; `complete` also checks box; `start` auto-stops a running task.
- `create`: resolve file (vault-relative), insert under header or append `<open-checkbox> body`.

## Deliberate fixes vs. reference bugs

- One unified, validated, strftime-driven date engine (reference had a second
  weaker, DST-fragile engine for date-shift keymaps).
- One file-IO path with consistent newline handling.
- `formats.duration` dropped (was inert in the reference).
- Custom `markerPrefix` honored on write (the Go impl hardcoded `::`; Lua fixed it; we keep the fix).

## Obsidian compliance checklist (must hold at release)

`this.app` (no global); minimal `onload`, heavy work in `onLayoutReady`;
`registerEvent/registerInterval/registerDomEvent/addCommand`; **empty `onunload`
re: leaves**, never store view refs, `instanceof`-check `leaf.view` (deferred
views); Editor/`Vault.process`/`processFrontMatter`; Vault API over Adapter;
`normalizePath`; no default hotkeys; no plugin name/id in command ids; CSS
classes + theme variables (no inline styles/hardcoded colors); no `console`
noise; lockfile committed; release tag == manifest version (no `v`), attach
`main.js`/`manifest.json`/`styles.css`.

## Module map & status (all implemented; `npm test` = 118 passing, lint + build clean)

Pure logic (no `obsidian` import; unit-tested):
- `src/types.ts` — Task/Marker/DateError
- `src/dates.ts` — local-noon epoch math (+tests)
- `src/config.ts` — settings, defaults, deep-merge
- `src/parse/strftime.ts` — strftime↔regex/format (+tests)
- `src/parse/parse.ts` — line parser, inline-due replace (+tests, 43 cases)
- `src/frontmatter.ts` — enrichment (+tests, 29 cases)
- `src/horizon.ts` — bucketing (+tests)
- `src/render/rows.ts` — display rows + sorting (+tests)
- `src/mutate.ts` — file-text primitives (+tests)
- `src/actions.ts` — verbs (+tests)
- `src/state.ts` — marker formatter + CurrentTask
- `src/errors.ts` — strict-error summary

Obsidian layer (App-dependent):
- `src/scan.ts` — vault scanner (Vault + metadataCache)
- `src/engine.ts` — orchestration: scan cache, verbs via `Vault.process`,
  timer (plugin data), date-shift (inline + `processFrontMatter` fallback),
  undo/redo
- `src/view.ts` — `TaskbufferView` ItemView (DOM rows, native checkbox,
  keyboard layer)
- `src/modals.ts` — create-task + tag-filter dialogs
- `src/settings.ts` — settings tab
- `src/main.ts` — lifecycle, commands (no default hotkeys), ribbon, status bar

Deferred / notes for a follow-up:
- Undo/redo currently covers inline date-shift edits (the common case); a
  frontmatter-due shift refreshes but is not on the undo stack.
- The checkbox click maps to "complete" (records `::complete`); "check off"
  (no marker) is the `x` key / command.

Tests live in `tests/*.test.ts` (vitest); pure-logic modules must not import
`obsidian`.
