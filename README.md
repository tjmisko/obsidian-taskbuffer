# Task Buffer

Aggregate the inline tasks scattered across your notes into a single, time-bucketed
view — **Overdue, Today, Tomorrow, This Week, This Month, This Year, …** — and
complete, defer, reschedule, or time-track them without leaving the buffer. Edits
are written straight back into the original note.

This is an Obsidian port of [taskbuffer.nvim](https://github.com/tjmisko/taskbuffer.nvim),
keeping the same plain-text task syntax so the same vault works in both.

## How tasks are written

A task is a single checkbox line in any note. Everything except the checkbox and
body is optional:

```markdown
- [ ] Buy groceries <30m> #errand (@[[2026-06-25]] 16:00)
```

| Part | Example | Notes |
| --- | --- | --- |
| Checkbox / status | `- [ ]` open · `- [x]` done · `- [-]` irrelevant | Only open tasks show in the buffer. Configurable. |
| Body | `Buy groceries` | Free text. |
| Duration | `<30m>` | Optional estimate. |
| Tags | `#errand` | Prefix configurable. |
| Due date | `(@[[2026-06-25]])` | Wrapper and date format configurable. A wikilink alias `[[id\|2026-06-25]]` or path `[[daily/2026-06-25]]` is stripped. |
| Due time | `16:00` | Inside the wrapper; kept verbatim. |
| State markers | `::start [[…]] 14:03` `::complete [[…]] 15:30` | Added automatically by the verbs below. |

A note's frontmatter can also drive tasks: undated tasks inherit the file's `due`,
file `tags` are merged in, files with a done `status` and a `due` hide their
loose tasks, and a file tagged `project` with a `due` becomes a single rolled-up
task. All of this is configurable in settings.

## Using it

Open the view with the ribbon icon or the **Task buffer: Open** command. In the
view:

- **Click the checkbox** to complete a task (records a completion time).
- **Double-click a row** (or press `Enter`) to jump to the source line.
- **Toolbar** buttons: new task, tag filter, toggle undated, toggle markers, reset, refresh.
- **Keyboard** (when the view is focused): `j`/`k` move · `Enter` open · `c`
  complete · `x` check off · `d` defer · `i` irrelevant · `u` undo irrelevant ·
  `b` start timer · `S` stop timer · `t` set due to today · `Shift`+`←`/`→` shift
  due ±1 day · `m` toggle markers · `#` filter tags · `z`/`Z` undo/redo a date
  change · `r` refresh.

Every action is also a command (searchable in the command palette and bindable to
your own hotkeys — no default hotkeys are set). Commands prefixed with "at cursor"
act on the task line under your cursor in any note.

## Settings

Sources to scan, the inbox file for new tasks, the horizon definitions and
overlap mode, week start, strict date validation, the full task format (date/time
strftime patterns, tag prefix, checkbox glyphs, date wrapper, marker prefix), and
the frontmatter keys (`due`, `status`, done values, due inheritance, required
tags).

## Privacy

Task Buffer runs entirely offline. It only reads and writes Markdown files inside
your vault, stores its settings and the running-timer state in the plugin's own
data, and makes **no network requests** and collects **no telemetry**.

Works on desktop and mobile.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production bundle
npm test        # unit tests (vitest)
npm run lint
```

The parsing, frontmatter, horizon, and rendering logic is pure TypeScript with no
Obsidian dependency, so it is unit-tested directly under Node. See `docs/PARITY.md`
for the design and the parity contract with taskbuffer.nvim.

## License

MIT — see [LICENSE](LICENSE).
