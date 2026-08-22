// Pure conversion from an immutable file-content snapshot to the engine's
// per-file cache entry. This module deliberately has no Obsidian imports: event
// payloads, mutation results, and vault reads all converge on the same parser.

import type { TaskbufferSettings } from "./config";
import { enrichFileTasks, projectTaskFor, type FileMeta } from "./frontmatter";
import { parseTask, type ParseContext, type RawMatch } from "./parse/parse";
import type { DateError, Task } from "./types";

/** Everything needed to parse one file, captured at a single point in time. */
export interface FileContentSnapshot {
	path: string;
	basename: string;
	mtime: number;
	size: number;
	content: string;
	frontmatter: Record<string, unknown> | null;
}

/** One scanned file's enriched tasks (regular tasks + its synthetic project task). */
export interface FileEntry {
	path: string;
	mtime: number;
	size: number;
	enriched: Task[];
	errors: DateError[];
}

/** Number of logical lines parsed from a snapshot (matching `String.split`). */
export function snapshotLineCount(snapshot: FileContentSnapshot): number {
	return snapshot.content.split("\n").length;
}

/**
 * Parse and enrich one supplied snapshot without consulting Obsidian or the
 * filesystem. Strict-mode errors are sliced to this file even when `ctx` is
 * shared by a full-vault reconciliation.
 */
export function fileEntryFromSnapshot(
	snapshot: FileContentSnapshot,
	ctx: ParseContext,
	settings: TaskbufferSettings,
): FileEntry {
	const errStart = ctx.dateErrors?.length ?? 0;
	const lines = snapshot.content.split("\n");
	const raw: Task[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match: RawMatch = {
			path: snapshot.path,
			lineNumber: i + 1,
			text: lines[i] as string,
		};
		const task = parseTask(match, ctx);
		if (task) raw.push(task);
	}

	const meta: FileMeta = {
		path: snapshot.path,
		basename: snapshot.basename,
		frontmatter: snapshot.frontmatter,
	};
	const enriched = enrichFileTasks(raw, meta, settings);
	const projectTask = projectTaskFor(meta, settings);
	if (projectTask) enriched.push(projectTask);

	return {
		path: snapshot.path,
		mtime: snapshot.mtime,
		size: snapshot.size,
		enriched,
		errors: ctx.dateErrors?.slice(errStart) ?? [],
	};
}
