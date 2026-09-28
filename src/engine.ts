// engine.ts — orchestration. Owns the scanned task cache and turns user intents
// (verbs, timer, date-shift, create) into atomic writes via the Vault API. The
// pure logic lives in parse/actions/mutate/horizon/rows; this layer is the only
// place that touches Obsidian's App, so the rest stays unit-testable.

import { App, Notice, normalizePath, TFile } from "obsidian";
import { TaskbufferSettings } from "./config";
import { Task } from "./types";
import { buildParseContext, extractInlineDueDate, ParseContext, replaceInlineDueDate } from "./parse/parse";
import { CurrentTask, formatMarker } from "./state";
import { scanVault, readFileEntry, fileForPath, type FileEntry, type FileReadTiming } from "./scan";
import {
	fileEntryFromSnapshot,
	snapshotLineCount,
	type FileContentSnapshot,
} from "./file-entry";
import { summarizeDateErrors } from "./errors";
import { buildSections, collectTags, DisplaySection, RenderOptions } from "./render/rows";
import { parseFrontmatterDue } from "./frontmatter";
import { addDays, todayEpoch } from "./dates";
import { formatEpoch } from "./parse/strftime";
import { trimSnapshot } from "./snapshot";
import { perfStart } from "./perf";
import * as actions from "./actions";
import * as mutate from "./mutate";

/** A single reversible line edit (for the date-shift undo stack). */
interface LineEdit {
	filePath: string;
	lineNumber: number;
	oldLine: string;
	newLine: string;
}

/** Persistence hook for the running-timer state (backed by plugin data). */
export interface TimerStore {
	get(): CurrentTask | null;
	set(task: CurrentTask | null): Promise<void>;
}

export type FileUpdateOrigin = "metadata" | "mutation";

export class TaskEngine {
	private app: App;
	private timer: TimerStore;
	settings: TaskbufferSettings;

	/** Per-file source of truth (Pillar B/C); the flat `tasks` list is derived. */
	private byFile = new Map<string, FileEntry>();
	/** Derived flat list (regular tasks, then synthetic project tasks). */
	tasks: Task[] = [];
	/** True between `hydrate` and the first `reconcile`: `tasks` holds only a
	 * persisted snapshot and `byFile` is empty, so an incremental update must
	 * reconcile first or `rebuildFlat` would wipe the list. */
	private hydratedOnly = false;
	/** The single in-flight reconcile, if any — so concurrent callers share one
	 * scan instead of racing two wholesale `byFile` reassignments. */
	private reconcilePromise: Promise<void> | null = null;
	/** Pillar D: persisted scan-cache entries for the NEXT reconcile to reuse
	 * (mtime+size matching). Consumed once; `refresh` discards it so a manual
	 * refresh / settings change re-reads every candidate. */
	private startupCache: Map<string, FileEntry> | null = null;

	private undoStack: LineEdit[][] = [];
	private redoStack: LineEdit[][] = [];

	constructor(app: App, settings: TaskbufferSettings, timer: TimerStore) {
		this.app = app;
		this.settings = settings;
		this.timer = timer;
	}

	private get ctx(): ParseContext {
		return buildParseContext(this.settings, this.settings.strict);
	}

	private nowEpoch(): number {
		return Date.now();
	}

	// ── scan / read ─────────────────────────────────────────────────────────

	/**
	 * Pillar A: adopt a persisted snapshot as the flat list so the view can paint
	 * before any scan. `byFile` stays empty until {@link reconcile}; any update in
	 * this window reconciles first (see {@link updateFileFromContent}).
	 */
	hydrate(snapshotTasks: Task[]): void {
		this.tasks = snapshotTasks;
		this.hydratedOnly = true;
	}

	/** The capped open-task slice to persist (all dated + first N undated). */
	snapshot(): Task[] {
		return trimSnapshot(this.tasks);
	}

	/** Adopt persisted scan-cache entries (Pillar D) for the next reconcile. */
	setStartupCache(entries: FileEntry[]): void {
		this.startupCache = new Map(entries.map((entry) => [entry.path, entry]));
	}

	/** The per-file cache to persist. Empty while only hydrated (`byFile` is not
	 * yet authoritative), which callers use as the don't-persist signal. */
	fileEntries(): FileEntry[] {
		return [...this.byFile.values()];
	}

	/**
	 * Pillar B: rebuild the per-file cache from a full candidate scan. This is the
	 * authoritative read; it clears the hydrated-only flag. Used at startup (after
	 * the snapshot paint) and by the manual refresh / settings-change paths.
	 */
	async reconcile(): Promise<void> {
		// Single-flight: a mutation's hydrated guard (or a manual refresh) that
		// fires while a reconcile is running joins the in-flight scan rather than
		// starting a second one whose wholesale `byFile =` would clobber an
		// interleaved updateFile splice.
		if (!this.reconcilePromise) {
			this.reconcilePromise = this.runReconcile().finally(() => {
				this.reconcilePromise = null;
			});
		}
		return this.reconcilePromise;
	}

	private async runReconcile(): Promise<void> {
		const end = perfStart("engine.reconcile (scanVault)");
		const reuse = this.startupCache;
		this.startupCache = null;
		const { entries, errors, read, reused } = await scanVault(this.app, this.settings, reuse ?? undefined);
		this.byFile = new Map(entries.map((entry) => [entry.path, entry]));
		this.hydratedOnly = false;
		this.rebuildFlat();
		end({ tasks: this.tasks.length, files: this.byFile.size, read, reused });
		if (this.settings.strict && errors.length > 0) {
			new Notice(summarizeDateErrors(errors), 8000);
		}
	}

	/** Full reconcile (manual "Refresh tasks" command / settings change).
	 * Discards any pending startup cache: this path exists to re-read reality. */
	async refresh(): Promise<void> {
		this.startupCache = null;
		await this.reconcile();
	}

	/** Re-read one file as an explicitly labeled fallback (currently rename and
	 * callers that genuinely lack content). Normal metadata/mutation updates use
	 * {@link updateFileFromContent} and perform no vault read. */
	async updateFile(path: string): Promise<void> {
		const end = perfStart("engine.updateFile");
		const reconcileWaitMs = await this.waitUntilAuthoritative();
		const file = fileForPath(this.app, path);
		if (!file) {
			const rebuildMs = this.removeFile(path);
			end({
				origin: "vault-fallback",
				file: path,
				removed: true,
				reconcileWaitMs,
				vaultReadMs: 0,
				parseMs: 0,
				rebuildMs,
				vaultReads: 0,
				byteCount: 0,
				lineCount: 0,
				fileTasks: 0,
				totalTasks: this.tasks.length,
			});
			return;
		}
		const ctx = this.ctx;
		const timing: FileReadTiming = { vaultReadMs: 0, parseMs: 0, byteCount: 0, lineCount: 0 };
		const entry = await readFileEntry(this.app, file, ctx, this.settings, timing);
		if (entry.enriched.length > 0) this.byFile.set(entry.path, entry);
		else this.byFile.delete(entry.path);
		const rebuildMs = this.rebuildFlat();
		end({
			origin: "vault-fallback",
			file: entry.path,
			reconcileWaitMs,
			vaultReadMs: timing.vaultReadMs,
			parseMs: timing.parseMs,
			rebuildMs,
			vaultReads: 1,
			byteCount: timing.byteCount,
			lineCount: timing.lineCount,
			fileTasks: entry.enriched.length,
			totalTasks: this.tasks.length,
		});
		this.reportErrors(entry.errors);
	}

	/** Parse supplied event/mutation content and splice it into the per-file cache. */
	async updateFileFromContent(snapshot: FileContentSnapshot, origin: FileUpdateOrigin): Promise<void> {
		const end = perfStart("engine.updateFile");
		const reconcileWaitMs = await this.waitUntilAuthoritative();
		const ctx = this.ctx;
		const parseStart = performance.now();
		const entry = fileEntryFromSnapshot(snapshot, ctx, this.settings);
		const parseMs = performance.now() - parseStart;
		if (entry.enriched.length > 0) this.byFile.set(entry.path, entry);
		else this.byFile.delete(entry.path);
		const rebuildMs = this.rebuildFlat();
		end({
			origin,
			file: entry.path,
			reconcileWaitMs,
			vaultReadMs: 0,
			parseMs,
			rebuildMs,
			vaultReads: 0,
			byteCount: snapshot.size,
			lineCount: snapshotLineCount(snapshot),
			fileTasks: entry.enriched.length,
			totalTasks: this.tasks.length,
		});
		this.reportErrors(entry.errors);
	}

	/** Wait for the per-file map to become authoritative before splicing it. */
	private async waitUntilAuthoritative(): Promise<number> {
		const start = performance.now();
		// A reconcile rebuilds byFile wholesale and yields mid-scan. Joining it
		// prevents that final assignment from clobbering this incremental update.
		if (this.reconcilePromise) await this.reconcilePromise;
		// A hydrated snapshot has no byFile map yet; fill it before one-file update.
		if (this.hydratedOnly) await this.reconcile();
		return performance.now() - start;
	}

	private reportErrors(errors: FileEntry["errors"]): void {
		if (this.settings.strict && errors.length > 0) {
			new Notice(summarizeDateErrors(errors), 8000);
		}
	}

	/** Drop a file's entry from the cache (delete / rename-away). */
	removeFile(path: string): number {
		return this.byFile.delete(path) ? this.rebuildFlat() : 0;
	}

	/**
	 * Derive the flat task list from the per-file cache. Regular tasks come first
	 * (file order), then synthetic project tasks — matching the order the full
	 * scan produced, so the view, `allTags`, and snapshots stay stable regardless
	 * of how byFile was assembled (full scan vs. incremental updates).
	 */
	private rebuildFlat(): number {
		const start = performance.now();
		const regular: Task[] = [];
		const projects: Task[] = [];
		for (const entry of this.byFile.values()) {
			for (const task of entry.enriched) {
				if (task.sortLast) projects.push(task);
				else regular.push(task);
			}
		}
		this.tasks = regular.concat(projects);
		return performance.now() - start;
	}

	sections(opts: RenderOptions): DisplaySection[] {
		return buildSections(this.tasks, this.settings, opts);
	}

	allTags(): string[] {
		return collectTags(this.tasks.filter((t) => t.status === "open"));
	}

	currentTask(): CurrentTask | null {
		return this.timer.get();
	}

	// ── write helpers ─────────────────────────────────────────────────────────

	private async transform(
		path: string,
		fn: (content: string) => string,
	): Promise<FileContentSnapshot | null> {
		const file = fileForPath(this.app, path);
		if (!file) {
			new Notice(`File not found: ${path}`);
			return null;
		}
		let transformed: string | null = null;
		try {
			await this.app.vault.process(file, (content) => {
				transformed = fn(content);
				return transformed;
			});
			return transformed === null ? null : this.contentSnapshot(file, transformed);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
			return null;
		}
	}

	private contentSnapshot(file: TFile, content: string): FileContentSnapshot {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
		return {
			path: file.path,
			basename: file.basename,
			mtime: file.stat.mtime,
			size: file.stat.size,
			content,
			frontmatter: frontmatter === null ? null : structuredClone(frontmatter),
		};
	}

	private async updateSnapshots(snapshots: Iterable<FileContentSnapshot>): Promise<void> {
		const latest = new Map<string, FileContentSnapshot>();
		for (const snapshot of snapshots) latest.set(snapshot.path, snapshot);
		for (const snapshot of latest.values()) await this.updateFileFromContent(snapshot, "mutation");
	}

	// ── verbs ───────────────────────────────────────────────────────────────

	async complete(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const snapshot = await this.transform(task.filePath, (c) => actions.completeAt(c, task.lineNumber, ctx, now));
		if (snapshot) await this.updateFileFromContent(snapshot, "mutation");
	}

	async check(task: Task): Promise<void> {
		const ctx = this.ctx;
		const snapshot = await this.transform(task.filePath, (c) => actions.check(c, task.lineNumber, ctx));
		if (snapshot) await this.updateFileFromContent(snapshot, "mutation");
	}

	async defer(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const snapshot = await this.transform(task.filePath, (c) => actions.defer(c, task.lineNumber, ctx, now));
		if (snapshot) await this.updateFileFromContent(snapshot, "mutation");
	}

	async markIrrelevant(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const snapshot = await this.transform(task.filePath, (c) => actions.irrelevant(c, task.lineNumber, ctx, now));
		if (snapshot) await this.updateFileFromContent(snapshot, "mutation");
	}

	async unsetIrrelevant(task: Task): Promise<void> {
		const ctx = this.ctx;
		const snapshot = await this.transform(task.filePath, (c) => actions.unset(c, task.lineNumber, ctx));
		if (snapshot) await this.updateFileFromContent(snapshot, "mutation");
	}

	// ── timer ─────────────────────────────────────────────────────────────────

	async startTimer(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const existing = this.timer.get();
		const snapshots: FileContentSnapshot[] = [];
		if (existing) {
			const stopped = await this.appendStop(existing, now);
			if (stopped) snapshots.push(stopped);
		}
		const started = await this.transform(task.filePath, (c) =>
			mutate.appendToLine(c, task.lineNumber, formatMarker("start", now, ctx)),
		);
		if (started) {
			snapshots.push(started);
			await this.timer.set({ startTime: now, name: task.body, filePath: task.filePath, lineNumber: task.lineNumber });
			new Notice(`Started: ${task.body}`);
		}
		await this.updateSnapshots(snapshots);
	}

	private async appendStop(ct: CurrentTask, now: number): Promise<FileContentSnapshot | null> {
		const ctx = this.ctx;
		const snapshot = await this.transform(ct.filePath, (c) =>
			mutate.appendToLine(c, ct.lineNumber, formatMarker("stop", now, ctx)),
		);
		await this.timer.set(null);
		return snapshot;
	}

	async stopTimer(): Promise<void> {
		const ct = this.timer.get();
		if (!ct) {
			new Notice("No task running");
			return;
		}
		const snapshot = await this.appendStop(ct, this.nowEpoch());
		new Notice(`Stopped: ${ct.name}`);
		if (snapshot) await this.updateFileFromContent(snapshot, "mutation");
	}

	async completeTimer(): Promise<void> {
		const ct = this.timer.get();
		if (!ct) {
			new Notice("No task running");
			return;
		}
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const snapshot = await this.transform(ct.filePath, (c) => actions.completeAt(c, ct.lineNumber, ctx, now));
		if (snapshot) {
			await this.timer.set(null);
			new Notice(`Completed: ${ct.name}`);
			await this.updateFileFromContent(snapshot, "mutation");
		}
	}

	// ── create ──────────────────────────────────────────────────────────────

	async create(body: string): Promise<void> {
		if (body.trim() === "") return;
		const ctx = this.ctx;
		const path = normalizePath(this.settings.inbox.file);
		const header = this.settings.inbox.header;
		const line = actions.newTaskLine(body.trim(), ctx);
		const existing = fileForPath(this.app, path);
		let snapshot: FileContentSnapshot | null = null;
		if (!existing) {
			await this.ensureParentFolder(path);
			const content = header ? mutate.insertAfterHeader(null, header, line) : mutate.appendToFile(null, line);
			try {
				const created = await this.app.vault.create(path, content);
				snapshot = this.contentSnapshot(created, content);
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e));
				return;
			}
		} else {
			snapshot = await this.transform(path, (c) =>
				header ? mutate.insertAfterHeader(c, header, line) : mutate.appendToFile(c, line),
			);
		}
		new Notice(`Added: ${body.trim()}`);
		if (snapshot) await this.updateFileFromContent(snapshot, "mutation");
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		const dir = path.slice(0, slash);
		if (this.app.vault.getFolderByPath(dir)) return;
		try {
			await this.app.vault.createFolder(dir);
		} catch {
			/* already exists / race — ignore */
		}
	}

	// ── date shift / set / defer-to ─────────────────────────────────────────────

	async shiftDate(task: Task, deltaDays: number): Promise<void> {
		if (task.dueDate !== null) {
			const newDate = formatEpoch(addDays(task.dueDate, deltaDays), this.settings.formats.date);
			const ctx = this.ctx;
			if (await this.rewriteLine(task, (line) => replaceInlineDueDate(line, ctx, newDate))) return;
		}
		await this.shiftFrontmatterDue(task, deltaDays);
	}

	async setDateToday(task: Task): Promise<void> {
		await this.setDate(task, todayEpoch());
	}

	/**
	 * Move the task's due date to `epoch`, writing it where it lives: an inline
	 * date is replaced in place; a date inherited from frontmatter (or a synthetic
	 * project task) updates the file's due key; an undated task gets an inline
	 * due date inserted. Line edits are undoable.
	 */
	async setDate(task: Task, epoch: number): Promise<void> {
		if (task.sortLast) {
			await this.setFrontmatterDue(task, epoch);
			return;
		}
		const ctx = this.ctx;
		const dateStr = formatEpoch(epoch, this.settings.formats.date);
		let inherited = false;
		await this.rewriteLine(task, (line) => {
			inherited = task.dueDate !== null && extractInlineDueDate(line, ctx) === null;
			return inherited ? null : actions.setDueOnLine(line, ctx, dateStr);
		});
		if (inherited) await this.setFrontmatterDue(task, epoch);
	}

	/**
	 * Defer to a picked date: record ::original/::deferral like `defer`, then move
	 * the due date to `epoch` (see actions.deferTo). A frontmatter-inherited date
	 * gets the markers on the line and the new date in frontmatter; a synthetic
	 * project task has no line to mark, so only its frontmatter moves.
	 */
	async deferTo(task: Task, epoch: number): Promise<void> {
		if (task.sortLast) {
			await this.setFrontmatterDue(task, epoch);
			return;
		}
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const dateStr = formatEpoch(epoch, this.settings.formats.date);
		let inherited = false;
		await this.rewriteLine(task, (line) => {
			inherited = task.dueDate !== null && extractInlineDueDate(line, ctx) === null;
			return inherited ? actions.defer(line, 1, ctx, now) : actions.deferTo(line, 1, ctx, now, dateStr);
		});
		if (inherited) await this.setFrontmatterDue(task, epoch);
	}

	/**
	 * Rewrite the task's own line through `fn` (null = leave it alone) in one
	 * atomic write and record it on the undo stack. Returns whether it changed.
	 */
	private async rewriteLine(task: Task, fn: (line: string) => string | null): Promise<boolean> {
		let edit: LineEdit | null = null;
		const snapshot = await this.transform(task.filePath, (content) => {
			const lines = content.split("\n");
			const line = lines[task.lineNumber - 1];
			if (line === undefined) return content;
			const next = fn(line);
			if (next === null || next === line) return content;
			edit = { filePath: task.filePath, lineNumber: task.lineNumber, oldLine: line, newLine: next };
			lines[task.lineNumber - 1] = next;
			return lines.join("\n");
		});
		if (!edit || !snapshot) return false;
		this.pushUndo([edit]);
		await this.updateFileFromContent(snapshot, "mutation");
		return true;
	}

	private fmDueString(epoch: number, time: string): string {
		return formatEpoch(epoch, "%Y-%m-%d") + (time ? " " + time : "");
	}

	private async shiftFrontmatterDue(task: Task, deltaDays: number): Promise<void> {
		const file = fileForPath(this.app, task.filePath);
		if (!file) return;
		const dueKey = this.settings.frontmatter.dueKey;
		let changed = false;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const raw = fm[dueKey];
			if (raw === undefined || raw === null) return;
			const parsed = parseFrontmatterDue(raw as string | Date);
			if (!parsed) return;
			fm[dueKey] = this.fmDueString(addDays(parsed.epoch, deltaDays), parsed.time);
			changed = true;
		});
		if (!changed) new Notice("No due date to shift");
	}

	/** Set the file's frontmatter due date to `epoch`, keeping any existing due time. */
	private async setFrontmatterDue(task: Task, epoch: number): Promise<void> {
		const file = fileForPath(this.app, task.filePath);
		if (!file) return;
		const dueKey = this.settings.frontmatter.dueKey;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const raw = fm[dueKey];
			const parsed = raw === undefined || raw === null ? null : parseFrontmatterDue(raw as string | Date);
			fm[dueKey] = this.fmDueString(epoch, parsed?.time ?? "");
		});
	}

	// ── undo / redo (date edits only) ───────────────────────────────────────────

	private pushUndo(edits: LineEdit[]): void {
		this.undoStack.push(edits);
		if (this.undoStack.length > 100) this.undoStack.shift();
		this.redoStack = [];
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}
	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	async undo(): Promise<void> {
		const edits = this.undoStack.pop();
		if (!edits) {
			new Notice("Nothing to undo");
			return;
		}
		const snapshots = await this.applyEdits(edits, "undo");
		if (snapshots) {
			this.redoStack.push(edits);
			await this.updateSnapshots(snapshots.values());
		} else {
			this.undoStack.push(edits); // restore on failure
		}
	}

	async redo(): Promise<void> {
		const edits = this.redoStack.pop();
		if (!edits) {
			new Notice("Nothing to redo");
			return;
		}
		const snapshots = await this.applyEdits(edits, "redo");
		if (snapshots) {
			this.undoStack.push(edits);
			await this.updateSnapshots(snapshots.values());
		} else {
			this.redoStack.push(edits);
		}
	}

	/** Apply each edit's target line, validating the current line matches the expected side. */
	private async applyEdits(
		edits: LineEdit[],
		dir: "undo" | "redo",
	): Promise<Map<string, FileContentSnapshot> | null> {
		const byFile = new Map<string, LineEdit[]>();
		const snapshots = new Map<string, FileContentSnapshot>();
		for (const e of edits) {
			const arr = byFile.get(e.filePath);
			if (arr) arr.push(e);
			else byFile.set(e.filePath, [e]);
		}
		for (const [path, fileEdits] of byFile) {
			const file = fileForPath(this.app, path);
			if (!(file instanceof TFile)) {
				new Notice(`File not found: ${path}`);
				return null;
			}
			let mismatch = false;
			const snapshot = await this.transform(path, (content) => {
				const lines = content.split("\n");
				for (const e of fileEdits) {
					const expected = dir === "undo" ? e.newLine : e.oldLine;
					const target = dir === "undo" ? e.oldLine : e.newLine;
					if (lines[e.lineNumber - 1] !== expected) {
						mismatch = true;
						return content;
					}
					lines[e.lineNumber - 1] = target;
				}
				return lines.join("\n");
			});
			if (mismatch) {
				new Notice("Line changed externally — cannot apply");
				return null;
			}
			if (!snapshot) return null;
			snapshots.set(path, snapshot);
		}
		return snapshots;
	}
}
