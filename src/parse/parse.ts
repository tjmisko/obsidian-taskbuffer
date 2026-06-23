// parse.ts — the task-line parser. Port of taskbuffer.nvim's parse.lua
// (itself a port of go/parse.go). Parses one source line into a Task:
//   1. status   — literal longest-first checkbox prefix match
//   2. due date — inline wrapper group (alias/path stripped), strict-validated
//   3. duration — hardcoded <Nm>
//   4. markers  — ::kind [[date]] [time], always literal [[ ]]
//   5. tags     — prefix + [A-Za-z_][\w-]*, whole line, source order
//   6. body     — text between checkbox and the date group / first marker
//
// Pure module — no Obsidian imports, so it runs under vitest. Task.dueDate is a
// local-noon epoch ms (null = undated); markers keep RAW date/time strings.

import { Task, TaskStatus, Marker, DateError } from "../types";
import { TaskbufferSettings } from "../config";
import { compile, components, validateDate, StrftimeSpec } from "./strftime";
import { ymdToEpoch } from "../dates";

const DEFAULT_CHECKBOX = { open: "- [ ]", done: "- [x]", irrelevant: "- [-]" };
const DEFAULT_DATE_FMT = "%Y-%m-%d";
const DEFAULT_TIME_FMT = "%H:%M";
const DEFAULT_TAG_PREFIX = "#";
const DEFAULT_MARKER_PREFIX = "::";
const DEFAULT_WRAPPER = ["(@[[", "]]", ")"];

/** A candidate task line located by the scanner. */
export interface RawMatch {
	path: string;
	lineNumber: number;
	text: string;
}

export interface ParseContext {
	checkboxes: string[]; // unique, longest-first (ties alphabetical)
	statusMap: Record<string, TaskStatus>;
	checkbox: { open: string; done: string; irrelevant: string }; // literals for write-back
	dateFmt: string; // raw strftime strings (for marker formatting)
	timeFmt: string;
	tagPrefix: string;
	tagSource: string; // regex source incl. escaped prefix; group 1 = tag
	dateSpec: StrftimeSpec;
	dateRegexTime: RegExp; // group1 = date, group2 = time
	dateRegexNoTime: RegExp; // group1 = date
	markerRegexTime: RegExp; // group1 kind, group2 date, group3 time
	markerRegexNoTime: RegExp; // group1 kind, group2 date
	markerStartRegex: RegExp;
	markerPrefix: string;
	durationRegex: RegExp;
	strict: boolean;
	dateErrors: DateError[] | null;
}

function regexEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split on every literal occurrence of `delim` (N delims -> N+1 parts). */
function splitPlain(s: string, delim: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (;;) {
		const i = s.indexOf(delim, start);
		if (i === -1) {
			parts.push(s.slice(start));
			return parts;
		}
		parts.push(s.slice(start, i));
		start = i + delim.length;
	}
}

/** Build a reusable ParseContext from settings. */
export function buildParseContext(
	settings: TaskbufferSettings,
	collectErrors = false,
): ParseContext {
	const formats = settings.formats ?? ({} as TaskbufferSettings["formats"]);

	// ── Checkbox / status ──────────────────────────────────────────────────
	const cbConfig =
		formats.checkbox && Object.keys(formats.checkbox).length > 0 ? formats.checkbox : DEFAULT_CHECKBOX;
	const filtered: Record<string, string> = {};
	for (const [name, cb] of Object.entries(cbConfig)) {
		if (typeof cb === "string" && cb.trim() !== "") filtered[name] = cb;
	}
	// status_map: checkbox -> status; duplicate glyph resolves to alphabetically-first name.
	const statusMap: Record<string, TaskStatus> = {};
	for (const [name, cb] of Object.entries(filtered)) {
		const existing = statusMap[cb];
		if (existing === undefined || name < existing) statusMap[cb] = name as TaskStatus;
	}
	// Unique checkbox strings, longest-first (ties alphabetical).
	const checkboxes = Array.from(new Set(Object.values(filtered)));
	checkboxes.sort((a, b) => (a.length !== b.length ? b.length - a.length : a < b ? -1 : 1));

	// ── Tag prefix ─────────────────────────────────────────────────────────
	const tagPrefix = typeof formats.tagPrefix === "string" && formats.tagPrefix !== "" ? formats.tagPrefix : DEFAULT_TAG_PREFIX;
	const tagSource = regexEscape(tagPrefix) + "([A-Za-z_][\\w-]*)";

	// ── Date / time formats ──────────────────────────────────────────────────
	const dateFmt = typeof formats.date === "string" && formats.date !== "" ? formats.date : DEFAULT_DATE_FMT;
	const timeFmt = typeof formats.time === "string" && formats.time !== "" ? formats.time : DEFAULT_TIME_FMT;
	const dateSpec = compile(dateFmt);
	const timeSpec = compile(timeFmt);
	const D = dateSpec.run;
	const T = timeSpec.run;

	// ── Inline due-date matchers (lazy .*? strips wikilink alias / path prefix) ─
	const wrapper = formats.dateWrapper;
	let open: string;
	let close2: string;
	let close3: string | undefined;
	let twoElem: boolean;
	if (Array.isArray(wrapper) && wrapper.length === 3 && wrapper[0] && wrapper[1] && wrapper[2]) {
		[open, close2, close3] = [wrapper[0], wrapper[1], wrapper[2]];
		twoElem = false;
	} else if (Array.isArray(wrapper) && wrapper.length === 2 && wrapper[0] && wrapper[1]) {
		[open, close2] = [wrapper[0], wrapper[1]];
		twoElem = true;
	} else {
		[open, close2, close3] = [DEFAULT_WRAPPER[0] as string, DEFAULT_WRAPPER[1] as string, DEFAULT_WRAPPER[2] as string];
		twoElem = false;
	}
	const po = regexEscape(open);
	const pc2 = regexEscape(close2);
	let dateRegexTime: RegExp;
	let dateRegexNoTime: RegExp;
	if (twoElem) {
		dateRegexTime = new RegExp(po + ".*?(" + D + ")\\s*(" + T + ")" + pc2);
		dateRegexNoTime = new RegExp(po + ".*?(" + D + ")\\s*" + pc2);
	} else {
		const pc3 = regexEscape(close3 as string);
		dateRegexTime = new RegExp(po + ".*?(" + D + ")" + pc2 + "\\s*(" + T + ")" + pc3);
		dateRegexNoTime = new RegExp(po + ".*?(" + D + ")" + pc2 + "\\s*" + pc3);
	}

	// ── Marker prefix + matchers (always literal [[ ]]) ──────────────────────
	const markerPrefix = typeof formats.markerPrefix === "string" && formats.markerPrefix !== "" ? formats.markerPrefix : DEFAULT_MARKER_PREFIX;
	const markerRegexTime = new RegExp("([A-Za-z0-9_]+)\\s+\\[\\[.*?(" + D + ")\\]\\]\\s*(" + T + ")");
	const markerRegexNoTime = new RegExp("([A-Za-z0-9_]+)\\s+\\[\\[.*?(" + D + ")\\]\\]");
	const markerStartRegex = new RegExp(regexEscape(markerPrefix) + "\\s*[A-Za-z0-9_]+\\s+\\[\\[");

	const checkbox = {
		open: filtered.open ?? DEFAULT_CHECKBOX.open,
		done: filtered.done ?? DEFAULT_CHECKBOX.done,
		irrelevant: filtered.irrelevant ?? DEFAULT_CHECKBOX.irrelevant,
	};

	return {
		checkboxes,
		statusMap,
		checkbox,
		dateFmt,
		timeFmt,
		tagPrefix,
		tagSource,
		dateSpec,
		dateRegexTime,
		dateRegexNoTime,
		markerRegexTime,
		markerRegexNoTime,
		markerStartRegex,
		markerPrefix,
		durationRegex: /<(\d+)m>/,
		strict: settings.strict === true,
		dateErrors: collectErrors ? [] : null,
	};
}

interface DateGroup {
	start: number; // 0-based, inclusive
	end: number; // 0-based, exclusive
	dateStr: string;
	timeStr: string;
}

// Mirror Go's leftmost match over an optional time group: both variants may
// match; the one whose match ends earliest is the actual leftmost group.
function findDateGroup(line: string, ctx: ParseContext): DateGroup | null {
	const mt = ctx.dateRegexTime.exec(line);
	const mn = ctx.dateRegexNoTime.exec(line);
	const endTime = mt ? mt.index + mt[0].length : Infinity;
	const endNo = mn ? mn.index + mn[0].length : Infinity;
	if (mt && mn) {
		if (endTime <= endNo) {
			return { start: mt.index, end: endTime, dateStr: mt[1] as string, timeStr: mt[2] ?? "" };
		}
		return { start: mn.index, end: endNo, dateStr: mn[1] as string, timeStr: "" };
	}
	if (mt) return { start: mt.index, end: endTime, dateStr: mt[1] as string, timeStr: mt[2] ?? "" };
	if (mn) return { start: mn.index, end: endNo, dateStr: mn[1] as string, timeStr: "" };
	return null;
}

function pushDateError(ctx: ParseContext, m: RawMatch, dateStr: string, context: string, reason: string): void {
	if (ctx.dateErrors !== null) {
		ctx.dateErrors.push({ filePath: m.path, lineNumber: m.lineNumber, dateStr, context, reason });
	}
}

/**
 * Extract the inline due-date string from a raw line (leftmost group), or null.
 * Used by the `defer` verb to copy the current due date into an ::original marker.
 */
export function extractInlineDueDate(line: string, ctx: ParseContext): string | null {
	const dg = findDateGroup(line, ctx);
	return dg ? dg.dateStr : null;
}

/**
 * Replace the inline due-date substring in `line` with `newDateStr`, preserving
 * the surrounding wrapper. Returns the new line, or null if no inline due date.
 * Used by the date-shift / set-today actions.
 */
export function replaceInlineDueDate(line: string, ctx: ParseContext, newDateStr: string): string | null {
	const dg = findDateGroup(line, ctx);
	if (!dg) return null;
	const region = line.slice(dg.start, dg.end);
	const rel = region.indexOf(dg.dateStr);
	if (rel === -1) return null;
	const abs = dg.start + rel;
	return line.slice(0, abs) + newDateStr + line.slice(abs + dg.dateStr.length);
}

/** Parse one matched line into a Task, or null when it should be skipped. */
export function parseTask(match: RawMatch, ctx: ParseContext): Task | null {
	const line = match.text.replace(/^[ \t]+/, "").replace(/[\r\n]+$/, "");

	// 1. Status — literal longest-first prefix match.
	let checkboxStr: string | undefined;
	let status: TaskStatus | undefined;
	for (const cb of ctx.checkboxes) {
		if (line.startsWith(cb)) {
			checkboxStr = cb;
			status = ctx.statusMap[cb];
			break;
		}
	}
	if (checkboxStr === undefined || status === undefined) return null;
	const checkboxEnd = checkboxStr.length;

	// 2. Inline due date (optional). Group span recorded regardless of validity.
	let dueDate: number | null = null;
	let dueTime = "";
	const dg = findDateGroup(line, ctx);
	if (dg) {
		const c = components(dg.dateStr, ctx.dateSpec);
		const val = validateDate(c);
		if (val.ok && c) {
			dueDate = ymdToEpoch(c.year, c.month, c.day);
			dueTime = dg.timeStr;
		} else if (ctx.strict) {
			pushDateError(ctx, match, dg.dateStr, "inline due date", val.reason ?? "invalid date");
		} else {
			return null; // non-strict: skip the whole line
		}
	}

	// 3. Duration — hardcoded <Nm> over the whole line.
	const durMatch = ctx.durationRegex.exec(line);
	const durNum = durMatch ? durMatch[1] : undefined;
	const duration = durNum ? durNum + "m" : "";

	// 4. Markers — slice after the date group (or from the first real marker).
	const markers: Marker[] = [];
	let after: string;
	if (dg) {
		after = line.slice(dg.end);
	} else {
		const mi = line.search(ctx.markerStartRegex);
		after = mi >= 0 ? line.slice(mi) : "";
	}
	for (const rawSeg of splitPlain(after, ctx.markerPrefix)) {
		const seg = rawSeg.trim();
		if (seg === "") continue;
		let kind: string | undefined;
		let mdate = "";
		let mtime = "";
		const mt = ctx.markerRegexTime.exec(seg);
		if (mt) {
			kind = mt[1];
			mdate = mt[2] ?? "";
			mtime = mt[3] ?? "";
		} else {
			const mn = ctx.markerRegexNoTime.exec(seg);
			if (mn) {
				kind = mn[1];
				mdate = mn[2] ?? "";
				mtime = "";
			}
		}
		if (kind) {
			if (ctx.strict && mdate !== "") {
				const val = validateDate(components(mdate, ctx.dateSpec));
				if (!val.ok) pushDateError(ctx, match, mdate, `marker (${kind})`, val.reason ?? "invalid date");
			}
			markers.push({ kind, date: mdate, time: mtime });
		}
	}

	// 5. Tags — whole line, source order.
	const tags: string[] = [];
	const tagGlobal = new RegExp(ctx.tagSource, "g");
	for (const m of line.matchAll(tagGlobal)) {
		if (m[1]) tags.push(m[1]);
	}

	// 6. Body.
	let body: string;
	if (dg) {
		body = line.slice(checkboxEnd, dg.start);
	} else {
		const mi = line.search(ctx.markerStartRegex);
		body = line.slice(checkboxEnd, mi >= 0 ? mi : line.length);
	}
	if (durNum) body = body.replace("<" + durNum + "m>", "");
	body = body.replace(new RegExp(ctx.tagSource, "g"), "");
	body = body.trim();

	return {
		filePath: match.path,
		lineNumber: match.lineNumber,
		body,
		dueDate,
		dueTime,
		duration,
		tags,
		status,
		markers,
		sortLast: false,
	};
}

/** Parse many matches, dropping unparseable lines. */
export function parseTasks(matches: RawMatch[], ctx: ParseContext): Task[] {
	const tasks: Task[] = [];
	for (const m of matches) {
		const task = parseTask(m, ctx);
		if (task) tasks.push(task);
	}
	return tasks;
}
