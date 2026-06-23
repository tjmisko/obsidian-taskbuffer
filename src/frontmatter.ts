// Frontmatter enrichment — TypeScript port of taskbuffer.nvim's
// `lua/taskbuffer/frontmatter.lua` (itself a port of go/frontmatter.go +
// scan.go:ScanProjects). The Lua implementation is AUTHORITATIVE.
//
// KEY ADAPTATION: under Obsidian the plugin receives each file's frontmatter
// ALREADY PARSED (from metadataCache), so this module does NOT hand-parse YAML.
// It consumes parsed frontmatter objects and applies the four enrichment passes
// in the SAME load-bearing order as the Lua pipeline:
//
//   1. tag inheritance     (merge_tags)
//   2. completion filtering (filter_completed — MUST precede due inheritance)
//   3. due inheritance     (merge_due)
//   4. synthetic project tasks (project_task / ScanProjects)
//
// Pure module: it MUST NOT import "obsidian" so it stays unit-testable in Node.

import { ymdToEpoch, isValidYMD } from "./dates";
import type { Task } from "./types";
import type { TaskbufferSettings } from "./config";

/** One scanned markdown file with its parsed frontmatter (or null when none). */
export interface FileMeta {
	path: string; // vault-relative file path (used as Task.filePath)
	basename: string; // filename without extension (used as project-task body)
	frontmatter: Record<string, unknown> | null; // parsed FM, or null
}

/** A frontmatter due value resolved to a noon epoch plus an optional raw time. */
export interface ParsedFrontmatterDue {
	epoch: number; // local-noon epoch ms (see {@link ymdToEpoch})
	time: string; // raw "HH:MM" carried from the due value, or ""
}

// ── frontmatter accessors (parity: get_string / get_string_slice / tags) ──────

/**
 * A file's frontmatter `tags`, but ONLY when the value is a LIST. A scalar
 * string `tags:` is IGNORED (mirrors the Lua reader, which only treats a parsed
 * list as tags). Non-string list items are dropped — tags are always strings.
 */
function fmTags(fm: Record<string, unknown> | null): string[] {
	if (!fm) return [];
	const value = fm["tags"];
	if (!Array.isArray(value)) return []; // scalar string tags ignored
	return value.filter((item): item is string => typeof item === "string");
}

/** Scalar string for a key; "" when absent or non-scalar (parity: get_string). */
function fmString(fm: Record<string, unknown> | null, key: string): string {
	if (!fm) return "";
	const value = fm[key];
	return typeof value === "string" ? value : "";
}

function isDate(value: unknown): value is Date {
	return (
		value instanceof Date ||
		(typeof value === "object" &&
			value !== null &&
			typeof (value as { getTime?: unknown }).getTime === "function")
	);
}

/**
 * The raw frontmatter due value as a usable scalar, or null when absent / not a
 * due-shaped scalar. Obsidian's metadataCache may hand a date back as a string
 * ("YYYY-MM-DD" / "YYYY-MM-DD HH:MM") or as a Date (when its YAML parser
 * resolved a bare date). Both are accepted; anything else (number, list, map)
 * is ignored, matching the Lua reader's scalar-only `due` handling.
 */
function fmDueRaw(fm: Record<string, unknown> | null, dueKey: string): string | Date | null {
	if (!fm) return null;
	const value = fm[dueKey];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed === "" ? null : trimmed;
	}
	if (isDate(value)) return value;
	return null;
}

// ── frontmatter due parsing (parity: normalize_bare_date + split_first_space +
//    parse_due_date, collapsed to the ISO date format this plugin uses) ────────

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Split on the FIRST space (parity: strings.SplitN(due, " ", 2)). */
function splitFirstSpace(s: string): [string, string] {
	const index = s.indexOf(" ");
	if (index === -1) return [s, ""];
	return [s.slice(0, index), s.slice(index + 1)];
}

/**
 * Resolve a frontmatter due value to a noon epoch (+ optional raw time), or null
 * when it cannot be parsed or is calendar-invalid.
 *
 * String form: split on the first space into a date part and a verbatim time
 * part; the date part is matched as `Y-M-D` and zero-padded (mirrors the Lua
 * `normalize_bare_date` parity guard for unpadded `2026-4-1` dates). The time
 * part is kept verbatim (trimmed), exactly as merge_due copies it to dueTime.
 *
 * Date form: the calendar day and time are read from the value's UTC components
 * — YAML/JS parse a bare date or a timezone-less timestamp as UTC, so UTC
 * extraction round-trips the authored date. A non-zero UTC time becomes "HH:MM".
 */
export function parseFrontmatterDue(value: string | Date): ParsedFrontmatterDue | null {
	if (isDate(value)) {
		const date = value;
		const ms = date.getTime();
		if (Number.isNaN(ms)) return null;
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const day = date.getUTCDate();
		if (!isValidYMD(year, month, day)) return null;
		const hours = date.getUTCHours();
		const minutes = date.getUTCMinutes();
		const time = hours === 0 && minutes === 0 ? "" : `${pad2(hours)}:${pad2(minutes)}`;
		return { epoch: ymdToEpoch(year, month, day), time };
	}

	const [datePart, timePart] = splitFirstSpace(value.trim());
	const match = datePart.match(/^(\d+)-(\d+)-(\d+)$/);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!isValidYMD(year, month, day)) return null;
	return { epoch: ymdToEpoch(year, month, day), time: timePart.trim() };
}

// ── resolved config + done-value set ──────────────────────────────────────────

interface ResolvedFrontmatterConfig {
	dueKey: string;
	statusKey: string;
	doneSet: Set<string>; // lowercased done values
	inheritDue: boolean;
	requireTags: string[];
}

function resolveConfig(settings: TaskbufferSettings): ResolvedFrontmatterConfig {
	const fm = settings.frontmatter;
	return {
		dueKey: fm.dueKey,
		statusKey: fm.status.key,
		doneSet: new Set(fm.status.doneValues.map((v) => v.toLowerCase())),
		inheritDue: fm.inheritDue,
		requireTags: fm.requireTags ?? [],
	};
}

// ── pipeline op 1: tag inheritance (parity: merge_tags) ───────────────────────

/**
 * Union a file's frontmatter tags into a task's tags: dedup, frontmatter tags
 * appended AFTER inline tags, original order preserved. Returns a new array.
 */
function mergeFrontmatterTags(taskTags: string[], frontmatterTags: string[]): string[] {
	const seen = new Set(taskTags);
	const out = [...taskTags];
	for (const tag of frontmatterTags) {
		if (!seen.has(tag)) {
			out.push(tag);
			seen.add(tag);
		}
	}
	return out;
}

// ── pipeline op 4: synthetic project task (parity: project_task) ──────────────

/**
 * Build a synthetic SortLast project Task from a file's frontmatter, or null.
 * Emitted only when the file is tagged with the literal "project" tag (NOT
 * gated by requireTags), has a frontmatter due, is NOT in a done status, and the
 * due parses to a valid date.
 */
function buildProjectTask(file: FileMeta, cfg: ResolvedFrontmatterConfig): Task | null {
	const fm = file.frontmatter;
	if (!fm) return null;

	const tags = fmTags(fm);
	if (!tags.includes("project")) return null;

	const dueRaw = fmDueRaw(fm, cfg.dueKey);
	if (dueRaw === null) return null;

	const status = fmString(fm, cfg.statusKey).toLowerCase();
	if (cfg.doneSet.has(status)) return null;

	const parsed = parseFrontmatterDue(dueRaw);
	if (!parsed) return null;

	return {
		filePath: file.path,
		lineNumber: 1,
		body: file.basename,
		dueDate: parsed.epoch,
		dueTime: parsed.time,
		duration: "",
		tags: [...tags],
		status: "open",
		markers: [],
		sortLast: true,
	};
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Apply the four enrichment passes (IN ORDER) and return the enriched task list
 * INCLUDING synthetic project tasks. Input Task objects are not mutated — each
 * task is shallow-copied with a fresh tags array before enrichment.
 */
export function enrichTasks(
	tasksByFile: Map<string, Task[]>,
	files: FileMeta[],
	settings: TaskbufferSettings,
): Task[] {
	const cfg = resolveConfig(settings);

	const frontmatterByPath = new Map<string, Record<string, unknown> | null>();
	for (const file of files) {
		frontmatterByPath.set(file.path, file.frontmatter);
	}
	const tagsForPath = (path: string): string[] =>
		fmTags(frontmatterByPath.get(path) ?? null);

	// Flatten, copying so we never mutate caller-owned task objects.
	let tasks: Task[] = [];
	for (const [path, fileTasks] of tasksByFile) {
		for (const task of fileTasks) {
			tasks.push({ ...task, filePath: path, tags: [...task.tags] });
		}
	}

	// 1. tag inheritance ------------------------------------------------------
	for (const task of tasks) {
		const frontmatterTags = tagsForPath(task.filePath);
		if (frontmatterTags.length > 0) {
			task.tags = mergeFrontmatterTags(task.tags, frontmatterTags);
		}
	}

	// 2. completion filtering (BEFORE due inheritance) ------------------------
	// Drop UNDATED tasks whose file has BOTH a frontmatter due AND a done
	// status. Inline-dated tasks always survive. If inheritance ran first,
	// every undated task in a done file would acquire a date and survive.
	const completedFile = new Map<string, boolean>();
	const checkedFile = new Set<string>();
	const kept: Task[] = [];
	for (const task of tasks) {
		if (task.dueDate !== null) {
			kept.push(task); // inline-dated always kept
			continue;
		}
		const path = task.filePath;
		if (!checkedFile.has(path)) {
			checkedFile.add(path);
			const fm = frontmatterByPath.get(path) ?? null;
			if (fm) {
				const hasDue = fmDueRaw(fm, cfg.dueKey) !== null;
				const status = fmString(fm, cfg.statusKey).toLowerCase();
				if (hasDue && cfg.doneSet.has(status)) {
					completedFile.set(path, true); // BOTH due AND done required
				}
			}
		}
		if (!completedFile.get(path)) {
			kept.push(task);
		}
	}
	tasks = kept;

	// 3. due inheritance ------------------------------------------------------
	if (cfg.inheritDue) {
		for (const task of tasks) {
			if (task.dueDate !== null) continue; // inline due always wins
			const fm = frontmatterByPath.get(task.filePath) ?? null;
			const dueRaw = fmDueRaw(fm, cfg.dueKey);
			if (dueRaw === null) continue;

			if (cfg.requireTags.length > 0) {
				// ALL required tags must be in the FILE's FM tags (independent of
				// the task's merged tags).
				const fileTags = new Set(tagsForPath(task.filePath));
				if (!cfg.requireTags.every((tag) => fileTags.has(tag))) continue;
			}

			const parsed = parseFrontmatterDue(dueRaw);
			if (!parsed) continue; // ignore invalid (calendar or format)
			task.dueDate = parsed.epoch;
			if (parsed.time !== "") {
				task.dueTime = parsed.time;
			}
		}
	}

	// 4. synthetic project tasks (appended last) ------------------------------
	for (const file of files) {
		const projectTask = buildProjectTask(file, cfg);
		if (projectTask) {
			tasks.push(projectTask);
		}
	}

	return tasks;
}
