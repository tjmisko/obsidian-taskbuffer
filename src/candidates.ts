// candidates.ts — pure candidate selection for the metadata-filtered reconcile
// (Pillar B). Decides which files MIGHT contain an open task or a project task
// using ONLY Obsidian's in-memory metadata (listItem glyphs + frontmatter) — no
// disk I/O. Over-inclusion is safe (the file is read and enrichment decides what
// survives); under-inclusion would silently lose visible tasks, so when in doubt
// a file is included.
//
// Pure module: it MUST NOT import "obsidian" so it stays unit-testable in Node.

import type { TaskbufferSettings } from "./config";

/** Obsidian-free view of one file's metadata, sufficient to decide candidacy. */
export interface FileCandidateInfo {
	path: string;
	/** `listItem.task` glyphs present in the file (open = " ", done = "x", …). */
	taskChars: string[];
	frontmatter: Record<string, unknown> | null;
	/** False when metadataCache has no entry yet → read the file to be safe. */
	cached: boolean;
}

/**
 * The checkbox glyph char(s) that mark an OPEN task, derived from
 * `formats.checkbox.open` (e.g. `"- [ ]"` → `[" "]`). Returns null when the
 * format has no parseable `[x]` slot; the caller then treats ANY task list item
 * as a candidate (and should log the fallback rather than silently read fewer
 * files).
 */
export function openCharsFromSettings(settings: TaskbufferSettings): string[] | null {
	const match = settings.formats.checkbox.open.match(/\[(.?)\]/);
	if (!match) return null;
	return [match[1] ?? ""]; // capture is " " for "[ ]", "" for "[]"
}

/**
 * Is this file a project candidate? Permissive superset of {@link
 * buildProjectTask}'s gate: frontmatter `tags` is a LIST containing "project"
 * AND a due value is present under the configured key. The full done-status /
 * date-validity checks happen when the file is actually enriched.
 */
export function isProjectFile(
	frontmatter: Record<string, unknown> | null,
	settings: TaskbufferSettings,
): boolean {
	if (!frontmatter) return false;
	const tags = frontmatter["tags"];
	if (!Array.isArray(tags) || !tags.includes("project")) return false;
	return dueIsPresent(frontmatter[settings.frontmatter.dueKey]);
}

/** A frontmatter due is "present" when it is a non-empty string or a valid Date. */
function dueIsPresent(due: unknown): boolean {
	if (typeof due === "string") return due.trim() !== "";
	if (due && typeof (due as { getTime?: unknown }).getTime === "function") {
		return !Number.isNaN((due as Date).getTime());
	}
	return false;
}

/**
 * Select the files a reconcile must read. A file is a candidate iff:
 *   - it is not yet cached (read to be safe), OR
 *   - it has a task list item whose glyph is in `openChars` (ANY task when
 *     `openChars` is null — the unparseable-glyph fallback), OR
 *   - its frontmatter marks it a project file.
 */
export function selectCandidates(
	infos: FileCandidateInfo[],
	openChars: string[] | null,
	settings: TaskbufferSettings,
): string[] {
	const openSet = openChars === null ? null : new Set(openChars);
	const out: string[] = [];
	for (const info of infos) {
		if (!info.cached) {
			out.push(info.path);
			continue;
		}
		const hasOpenTask =
			openSet === null ? info.taskChars.length > 0 : info.taskChars.some((c) => openSet.has(c));
		if (hasOpenTask || isProjectFile(info.frontmatter, settings)) {
			out.push(info.path);
		}
	}
	return out;
}
