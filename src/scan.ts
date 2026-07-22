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
import { perfStart } from "./perf";
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
	size: number; // TFile.stat.size; mtime+size together decide scan-cache reuse
	enriched: Task[]; // per-file enrichment output (regular tasks, then project task)
	errors: DateError[]; // strict-mode date errors from this file's parse
}

export interface ScanResult {
	entries: FileEntry[];
	errors: DateError[];
	read: number; // candidate files actually read from disk
	reused: number; // candidate files reused from the scan cache (no read)
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
	// Parse + enrichment are synchronous after the single await above, so even
	// with concurrent batch reads the shared ctx grows only by THIS file's errors
	// between here and the slice below.
	const errStart = ctx.dateErrors?.length ?? 0;
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
	const errors = ctx.dateErrors?.slice(errStart) ?? [];
	return { path: file.path, mtime: file.stat.mtime, size: file.stat.size, enriched, errors };
}

let warnedOpenGlyph = false;

/**
 * The in-source files that MIGHT hold an open or project task, decided from the
 * in-memory metadataCache alone (no disk I/O). This is the Pillar-B filter that
 * turns a whole-vault read (~6k files) into ~the files that actually have open
 * tasks (~hundreds). The full read + enrichment happens only on these.
 */
export function candidateFiles(app: App, settings: TaskbufferSettings): TFile[] {
	const end = perfStart("  candidates");
	const files = app.vault.getMarkdownFiles().filter((f) => fileInSources(f.path, settings.sources));
	const openChars = openCharsFromSettings(settings);
	if (openChars === null && !warnedOpenGlyph) {
		warnedOpenGlyph = true;
		console.warn(
			"[taskbuffer] formats.checkbox.open has no parseable [x] slot; treating any task list item as a candidate.",
		);
	}
	let uncached = 0;
	const infos: FileCandidateInfo[] = files.map((file) => {
		const cache = app.metadataCache.getFileCache(file);
		if (cache === null) uncached += 1;
		const taskChars = (cache?.listItems ?? [])
			.map((li) => li.task)
			.filter((t): t is string => typeof t === "string");
		return { path: file.path, taskChars, frontmatter: cache?.frontmatter ?? null, cached: cache !== null };
	});
	const selected = new Set(selectCandidates(infos, openChars, settings));
	const result = files.filter((file) => selected.has(file.path));
	// `uncached` near `total` means metadataCache wasn't ready yet, so the filter
	// degraded toward read-all (safe, but slow) — the key reconcile-cost signal.
	end({ candidates: result.length, total: files.length, uncached });
	return result;
}

/** Candidate files read per batch before yielding the main thread. */
const SCAN_BATCH_SIZE = 50;

/**
 * Yield to the event loop so the browser can paint a frame and handle input
 * between scan batches. A macrotask (setTimeout) is required: a microtask
 * (`Promise.resolve()`) would run before the next render and so would NOT
 * actually return control to rendering.
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Scan the candidate files (Pillar B) and return the entries that hold tasks.
 * When `reuse` (Pillar D: the persisted scan cache, or the live per-file cache)
 * has an entry whose mtime+size still match the vault's in-memory file index,
 * that entry is adopted WITHOUT reading the file. On mobile every read crosses
 * the JS↔native bridge (~15ms/file), so skipping unchanged files is what turns
 * a ~10s cold-start reconcile into a sub-second one.
 */
export async function scanVault(
	app: App,
	settings: TaskbufferSettings,
	reuse?: ReadonlyMap<string, FileEntry>,
): Promise<ScanResult> {
	const ctx = buildParseContext(settings, settings.strict);
	const files = candidateFiles(app, settings);

	const byPath = new Map<string, FileEntry>();
	const reusedErrors: DateError[] = [];
	const toRead: TFile[] = [];
	for (const file of files) {
		const cached = reuse?.get(file.path);
		if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
			byPath.set(file.path, cached);
			reusedErrors.push(...cached.errors);
		} else {
			toRead.push(file);
		}
	}

	// Read + parse in batches. Within a batch reads run concurrently (cachedRead
	// is async I/O); between batches we yield so the cumulative synchronous parse
	// work doesn't block paint/input for the whole reconcile.
	for (let i = 0; i < toRead.length; i += SCAN_BATCH_SIZE) {
		const batch = toRead.slice(i, i + SCAN_BATCH_SIZE);
		const read = await Promise.all(batch.map((file) => readFileEntry(app, file, ctx, settings)));
		for (const entry of read) byPath.set(entry.path, entry);
		if (i + SCAN_BATCH_SIZE < toRead.length) await yieldToEventLoop();
	}

	// Emit in candidate order regardless of how entries were sourced, so the
	// flat list (and thus snapshots) is byte-stable across cached/uncached runs.
	const entries: FileEntry[] = [];
	for (const file of files) {
		const entry = byPath.get(file.path);
		if (entry && entry.enriched.length > 0) entries.push(entry);
	}
	return {
		entries,
		errors: (ctx.dateErrors ?? []).concat(reusedErrors),
		read: toRead.length,
		reused: files.length - toRead.length,
	};
}

/** Resolve a vault-relative path to a TFile, or null. */
export function fileForPath(app: App, path: string): TFile | null {
	const file = app.vault.getFileByPath(normalizePath(path));
	return file instanceof TFile ? file : null;
}
