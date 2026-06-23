// scan.ts — vault scanning. Obsidian's replacement for taskbuffer.nvim's
// ripgrep pass: enumerate markdown files (filtered to the configured sources),
// read each via the cached Vault API, parse every line into candidate tasks,
// then enrich from frontmatter. Frontmatter comes parsed from the metadataCache,
// so we never hand-parse YAML.
//
// Reads are per-file (`readFileEntry`) so a full scan and a single-file
// incremental update share the same code path; the engine holds the resulting
// per-file entries and derives its flat task list from them.

import { App, TFile, normalizePath } from "obsidian";
import { TaskbufferSettings } from "./config";
import { buildParseContext, parseTask, ParseContext, RawMatch } from "./parse/parse";
import { enrichFileTasks, projectTaskFor, FileMeta } from "./frontmatter";
import { FileCandidateInfo, openCharsFromSettings, selectCandidates } from "./candidates";
import { Task, DateError } from "./types";

/** Is `path` inside one of the configured source folders? Empty list = whole vault. */
export function fileInSources(path: string, sources: string[]): boolean {
	if (sources.length === 0) return true;
	return sources.some((raw) => {
		const src = normalizePath(raw);
		if (src === "" || src === "/" || src === ".") return true;
		return path === src || path.startsWith(src + "/");
	});
}

/** One scanned file's enriched tasks (regular tasks + its synthetic project task). */
export interface FileEntry {
	path: string; // vault-relative file path
	mtime: number; // TFile.stat.mtime
	enriched: Task[]; // per-file enrichment output (regular tasks, then project task)
}

export interface ScanResult {
	entries: FileEntry[];
	errors: DateError[];
}

/**
 * Read ONE file, parse its lines into raw tasks, and enrich from its frontmatter
 * into a {@link FileEntry}. The shared `ctx` accumulates strict-mode date errors
 * across a multi-file scan. A file with no open/done tasks and no project
 * frontmatter yields an entry whose `enriched` is empty.
 */
export async function readFileEntry(
	app: App,
	file: TFile,
	ctx: ParseContext,
	settings: TaskbufferSettings,
): Promise<FileEntry> {
	const content = await app.vault.cachedRead(file);
	const lines = content.split("\n");
	const raw: Task[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match: RawMatch = { path: file.path, lineNumber: i + 1, text: lines[i] as string };
		const task = parseTask(match, ctx);
		if (task) raw.push(task);
	}
	const meta: FileMeta = {
		path: file.path,
		basename: file.basename,
		frontmatter: app.metadataCache.getFileCache(file)?.frontmatter ?? null,
	};
	const enriched = enrichFileTasks(raw, meta, settings);
	const projectTask = projectTaskFor(meta, settings);
	if (projectTask) enriched.push(projectTask);
	return { path: file.path, mtime: file.stat.mtime, enriched };
}

let warnedOpenGlyph = false;

/**
 * The in-source files that MIGHT hold an open or project task, decided from the
 * in-memory metadataCache alone (no disk I/O). This is the Pillar-B filter that
 * turns a whole-vault read (~6k files) into ~the files that actually have open
 * tasks (~hundreds). The full read + enrichment happens only on these.
 */
export function candidateFiles(app: App, settings: TaskbufferSettings): TFile[] {
	const files = app.vault.getMarkdownFiles().filter((f) => fileInSources(f.path, settings.sources));
	const openChars = openCharsFromSettings(settings);
	if (openChars === null && !warnedOpenGlyph) {
		warnedOpenGlyph = true;
		console.warn(
			"[taskbuffer] formats.checkbox.open has no parseable [x] slot; treating any task list item as a candidate.",
		);
	}
	const infos: FileCandidateInfo[] = files.map((file) => {
		const cache = app.metadataCache.getFileCache(file);
		const taskChars = (cache?.listItems ?? [])
			.map((li) => li.task)
			.filter((t): t is string => typeof t === "string");
		return { path: file.path, taskChars, frontmatter: cache?.frontmatter ?? null, cached: cache !== null };
	});
	const selected = new Set(selectCandidates(infos, openChars, settings));
	return files.filter((file) => selected.has(file.path));
}

/** Scan the candidate files (Pillar B) and return the entries that hold tasks. */
export async function scanVault(app: App, settings: TaskbufferSettings): Promise<ScanResult> {
	const ctx = buildParseContext(settings, settings.strict);
	const files = candidateFiles(app, settings);

	// Read candidates (cachedRead is in-memory after first read) in parallel.
	const all = await Promise.all(files.map((file) => readFileEntry(app, file, ctx, settings)));
	const entries = all.filter((entry) => entry.enriched.length > 0);
	return { entries, errors: ctx.dateErrors ?? [] };
}

/** Resolve a vault-relative path to a TFile, or null. */
export function fileForPath(app: App, path: string): TFile | null {
	const file = app.vault.getFileByPath(normalizePath(path));
	return file instanceof TFile ? file : null;
}
