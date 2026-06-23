// rows.ts — the display model. Turns enriched tasks into ordered, sorted
// sections of STRUCTURED rows (separate date/time/duration/body/tags fields —
// never a rendered text line). Mirrors taskbuffer.nvim's format.lua + list.lua
// filtering/sorting/sectioning, but the actual DOM rendering lives in the view.
//
// Pure module — no Obsidian imports.

import { Task, Marker } from "../types";
import { TaskbufferSettings, effectiveHorizons } from "../config";
import { resolveHorizons, bucketDatedTasks } from "../horizon";
import { formatEpoch } from "../parse/strftime";

/** One task as separated display fields. The view styles each field. */
export interface DisplayRow {
	task: Task;
	dateText: string; // formatted via formats.date, or "" when undated
	timeText: string; // verbatim due time, or ""
	durationText: string; // verbatim duration ("90m"), or ""
	body: string;
	tags: string[]; // raw (no prefix); the view prepends formats.tagPrefix
	markers: Marker[];
}

export interface DisplaySection {
	label: string;
	rows: DisplayRow[];
}

export interface RenderOptions {
	today: number; // local-noon epoch ms
	showUndated: boolean;
	showMarkers: boolean;
	tagFilter: string[]; // OR filter; empty = no filter
}

function matchesTagFilter(task: Task, filter: string[]): boolean {
	if (filter.length === 0) return true;
	return task.tags.some((t) => filter.includes(t));
}

// Dated sort: due date -> path -> real-before-synthetic -> line number.
function compareDated(a: Task, b: Task): number {
	const byDate = (a.dueDate as number) - (b.dueDate as number);
	if (byDate !== 0) return byDate;
	if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
	const bySortLast = Number(a.sortLast) - Number(b.sortLast);
	if (bySortLast !== 0) return bySortLast;
	return a.lineNumber - b.lineNumber;
}

// Undated sort: path -> real-before-synthetic -> line number.
function compareUndated(a: Task, b: Task): number {
	if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
	const bySortLast = Number(a.sortLast) - Number(b.sortLast);
	if (bySortLast !== 0) return bySortLast;
	return a.lineNumber - b.lineNumber;
}

/**
 * Build the ordered, non-empty sections for the task buffer. Only `open` tasks
 * appear (done/irrelevant are filtered out, matching the reference view). The
 * undated section, when enabled, is always last.
 */
export function buildSections(tasks: Task[], settings: TaskbufferSettings, opts: RenderOptions): DisplaySection[] {
	const visible = tasks.filter((t) => t.status === "open" && matchesTagFilter(t, opts.tagFilter));
	const dated = visible.filter((t) => t.dueDate !== null);
	const undatedTasks = visible.filter((t) => t.dueDate === null);

	const { dated: resolved, undated } = resolveHorizons(effectiveHorizons(settings), opts.today, settings.weekStart);
	const buckets = bucketDatedTasks(dated, resolved, settings.horizonsOverlap);

	// Section display order: cutoff-ascending for "sorted", else spec/`order`.
	const orderedHorizons =
		settings.horizonsOverlap === "sorted"
			? [...resolved].sort((a, b) => a.cutoff - b.cutoff)
			: [...resolved].sort((a, b) => a.order - b.order);

	const toRow = (task: Task): DisplayRow => ({
		task,
		dateText: task.dueDate !== null ? formatEpoch(task.dueDate, settings.formats.date) : "",
		timeText: task.dueTime,
		durationText: task.duration,
		body: task.body,
		tags: task.tags,
		markers: opts.showMarkers ? task.markers : [],
	});

	const sections: DisplaySection[] = [];
	const emitted = new Set<string>();
	for (const h of orderedHorizons) {
		if (emitted.has(h.label)) continue; // guard against duplicate labels
		emitted.add(h.label);
		const bucket = buckets.get(h.label);
		if (!bucket || bucket.length === 0) continue;
		const rows = [...bucket].sort(compareDated).map(toRow);
		sections.push({ label: h.label, rows });
	}

	if (opts.showUndated && undated && undatedTasks.length > 0) {
		const rows = [...undatedTasks].sort(compareUndated).map(toRow);
		sections.push({ label: undated.label, rows });
	}

	return sections;
}

/** All distinct tags across the given tasks, in first-seen order (for the filter picker). */
export function collectTags(tasks: Task[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of tasks) {
		for (const tag of t.tags) {
			if (!seen.has(tag)) {
				seen.add(tag);
				out.push(tag);
			}
		}
	}
	return out;
}
