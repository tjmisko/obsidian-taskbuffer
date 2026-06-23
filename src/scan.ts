// scan.ts — vault scanning. Obsidian's replacement for taskbuffer.nvim's
// ripgrep pass: enumerate markdown files (filtered to the configured sources),
// read each via the cached Vault API, parse every line into candidate tasks,
// then enrich from frontmatter. Frontmatter comes parsed from the metadataCache,
// so we never hand-parse YAML.

import { App, TFile, normalizePath } from "obsidian";
import { TaskbufferSettings } from "./config";
import { buildParseContext, parseTask, RawMatch } from "./parse/parse";
import { enrichTasks, FileMeta } from "./frontmatter";
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

export interface ScanResult {
	tasks: Task[];
	errors: DateError[];
}

/** Scan the vault and return enriched, open+done+irrelevant tasks (the view filters status). */
export async function scanVault(app: App, settings: TaskbufferSettings): Promise<ScanResult> {
	const ctx = buildParseContext(settings, settings.strict);
	const files = app.vault.getMarkdownFiles().filter((f) => fileInSources(f.path, settings.sources));

	// Read all files (cachedRead is in-memory after first read) in parallel.
	const contents = await Promise.all(
		files.map(async (file) => ({ file, content: await app.vault.cachedRead(file) })),
	);

	const tasksByFile = new Map<string, Task[]>();
	const metas: FileMeta[] = [];
	for (const { file, content } of contents) {
		metas.push({
			path: file.path,
			basename: file.basename,
			frontmatter: app.metadataCache.getFileCache(file)?.frontmatter ?? null,
		});
		const lines = content.split("\n");
		const parsed: Task[] = [];
		for (let i = 0; i < lines.length; i++) {
			const match: RawMatch = { path: file.path, lineNumber: i + 1, text: lines[i] as string };
			const task = parseTask(match, ctx);
			if (task) parsed.push(task);
		}
		if (parsed.length > 0) tasksByFile.set(file.path, parsed);
	}

	const tasks = enrichTasks(tasksByFile, metas, settings);
	return { tasks, errors: ctx.dateErrors ?? [] };
}

/** Resolve a vault-relative path to a TFile, or null. */
export function fileForPath(app: App, path: string): TFile | null {
	const file = app.vault.getFileByPath(normalizePath(path));
	return file instanceof TFile ? file : null;
}
