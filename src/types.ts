// Core data model. Mirrors the Task/Marker structs from taskbuffer.nvim
// (Go `parse.go`, Lua `parse.lua`). These types are pure data — no Obsidian
// imports — so the parsing/horizon/render logic stays unit-testable under Node.

export type TaskStatus = "open" | "done" | "irrelevant";

/**
 * A state marker appended to a task line, e.g. `::start [[2026-02-17]] 15:17`.
 * Dates/times are kept as the raw, unnormalized strings exactly as written.
 */
export interface Marker {
	kind: string; // start | stop | complete | deferral | original | irrelevant | <open-ended>
	date: string; // raw date string as written
	time: string; // raw time string, or "" when absent
}

/**
 * A single parsed task. `dueDate` is a local-noon epoch in milliseconds
 * (see {@link ymdToEpoch}); `null` means undated. `dueTime` and `duration`
 * are kept verbatim and never reformatted.
 */
export interface Task {
	filePath: string;
	lineNumber: number; // 1-based line within the source file
	body: string;
	dueDate: number | null; // local-noon epoch ms; null = undated
	dueTime: string; // "" or e.g. "16:00" / "09:00 AM"
	duration: string; // "" or e.g. "90m"
	tags: string[];
	status: TaskStatus;
	markers: Marker[];
	sortLast: boolean; // synthetic project tasks sort after real tasks
}

/** A date that failed strict-mode validation. Mirrors the Go/Lua DateError. */
export interface DateError {
	filePath: string;
	lineNumber: number | null; // null for frontmatter-level errors
	dateStr: string;
	context: string; // "inline due date", "marker (start)", ...
	reason: string;
}
