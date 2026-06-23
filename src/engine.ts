// engine.ts — orchestration. Owns the scanned task cache and turns user intents
// (verbs, timer, date-shift, create) into atomic writes via the Vault API. The
// pure logic lives in parse/actions/mutate/horizon/rows; this layer is the only
// place that touches Obsidian's App, so the rest stays unit-testable.

import { App, Notice, normalizePath, TFile } from "obsidian";
import { TaskbufferSettings } from "./config";
import { Task } from "./types";
import { buildParseContext, ParseContext, replaceInlineDueDate } from "./parse/parse";
import { CurrentTask, formatMarker } from "./state";
import { scanVault, readFileEntry, fileForPath, FileEntry } from "./scan";
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

export class TaskEngine {
	private app: App;
	private timer: TimerStore;
	settings: TaskbufferSettings;

	/** Per-file source of truth (Pillar B/C); the flat `tasks` list is derived. */
	private byFile = new Map<string, FileEntry>();
	/** Derived flat list (regular tasks, then synthetic project tasks). */
	tasks: Task[] = [];
	/** True between `hydrate` and the first `reconcile`: `tasks` holds only a
	 * persisted snapshot and `byFile` is empty, so a mutation must reconcile first
	 * or `rebuildFlat` would wipe the list. */
	private hydratedOnly = false;

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
	 * before any scan. `byFile` stays empty until {@link reconcile}; any mutation
	 * in this window reconciles first (see {@link updateFile}).
	 */
	hydrate(snapshotTasks: Task[]): void {
		this.tasks = snapshotTasks;
		this.hydratedOnly = true;
	}

	/** The capped open-task slice to persist (all dated + first N undated). */
	snapshot(): Task[] {
		return trimSnapshot(this.tasks);
	}

	/**
	 * Pillar B: rebuild the per-file cache from a full candidate scan. This is the
	 * authoritative read; it clears the hydrated-only flag. Used at startup (after
	 * the snapshot paint) and by the manual refresh / settings-change paths.
	 */
	async reconcile(): Promise<void> {
		const end = perfStart("engine.reconcile (scanVault)");
		const { entries, errors } = await scanVault(this.app, this.settings);
		this.byFile = new Map(entries.map((entry) => [entry.path, entry]));
		this.hydratedOnly = false;
		this.rebuildFlat();
		end({ tasks: this.tasks.length, files: this.byFile.size });
		if (this.settings.strict && errors.length > 0) {
			new Notice(summarizeDateErrors(errors), 8000);
		}
	}

	/** Full reconcile (manual "Refresh tasks" command / settings change). */
	async refresh(): Promise<void> {
		await this.reconcile();
	}

	/**
	 * Re-read ONE file and splice it into the per-file cache (Pillar C). Removes
	 * the entry when the file is gone or yields no tasks. Verbs call this for the
	 * single file they touched instead of rescanning the whole vault.
	 */
	async updateFile(path: string): Promise<void> {
		// If we are still showing only the hydrated snapshot, reconcile first so a
		// single-file splice doesn't collapse the list to just this file.
		if (this.hydratedOnly) await this.reconcile();
		const end = perfStart("engine.updateFile");
		const file = fileForPath(this.app, path);
		if (!file) {
			this.removeFile(path);
			end({ file: path, removed: true });
			return;
		}
		const ctx = this.ctx;
		const entry = await readFileEntry(this.app, file, ctx, this.settings);
		if (entry.enriched.length > 0) this.byFile.set(entry.path, entry);
		else this.byFile.delete(entry.path);
		this.rebuildFlat();
		end({ file: entry.path, fileTasks: entry.enriched.length, tasks: this.tasks.length });
		const errors = ctx.dateErrors ?? [];
		if (this.settings.strict && errors.length > 0) {
			new Notice(summarizeDateErrors(errors), 8000);
		}
	}

	/** Drop a file's entry from the cache (delete / rename-away). */
	removeFile(path: string): void {
		if (this.byFile.delete(path)) this.rebuildFlat();
	}

	/**
	 * Derive the flat task list from the per-file cache. Regular tasks come first
	 * (file order), then synthetic project tasks — matching the order the full
	 * scan produced, so the view, `allTags`, and snapshots stay stable regardless
	 * of how byFile was assembled (full scan vs. incremental updates).
	 */
	private rebuildFlat(): void {
		const regular: Task[] = [];
		const projects: Task[] = [];
		for (const entry of this.byFile.values()) {
			for (const task of entry.enriched) {
				if (task.sortLast) projects.push(task);
				else regular.push(task);
			}
		}
		this.tasks = regular.concat(projects);
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

	private async transform(path: string, fn: (content: string) => string): Promise<boolean> {
		const file = fileForPath(this.app, path);
		if (!file) {
			new Notice(`File not found: ${path}`);
			return false;
		}
		try {
			await this.app.vault.process(file, fn);
			return true;
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
			return false;
		}
	}

	// ── verbs ───────────────────────────────────────────────────────────────

	async complete(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		if (await this.transform(task.filePath, (c) => actions.completeAt(c, task.lineNumber, ctx, now))) {
			await this.updateFile(task.filePath);
		}
	}

	async check(task: Task): Promise<void> {
		const ctx = this.ctx;
		if (await this.transform(task.filePath, (c) => actions.check(c, task.lineNumber, ctx))) {
			await this.updateFile(task.filePath);
		}
	}

	async defer(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		if (await this.transform(task.filePath, (c) => actions.defer(c, task.lineNumber, ctx, now))) {
			await this.updateFile(task.filePath);
		}
	}

	async markIrrelevant(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		if (await this.transform(task.filePath, (c) => actions.irrelevant(c, task.lineNumber, ctx, now))) {
			await this.updateFile(task.filePath);
		}
	}

	async unsetIrrelevant(task: Task): Promise<void> {
		const ctx = this.ctx;
		if (await this.transform(task.filePath, (c) => actions.unset(c, task.lineNumber, ctx))) {
			await this.updateFile(task.filePath);
		}
	}

	// ── timer ─────────────────────────────────────────────────────────────────

	async startTimer(task: Task): Promise<void> {
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const existing = this.timer.get();
		if (existing) await this.appendStop(existing, now);
		const ok = await this.transform(task.filePath, (c) =>
			mutate.appendToLine(c, task.lineNumber, formatMarker("start", now, ctx)),
		);
		if (ok) {
			await this.timer.set({ startTime: now, name: task.body, filePath: task.filePath, lineNumber: task.lineNumber });
			new Notice(`Started: ${task.body}`);
			// Stopping an existing timer wrote to its file too; update both.
			if (existing && existing.filePath !== task.filePath) await this.updateFile(existing.filePath);
			await this.updateFile(task.filePath);
		}
	}

	private async appendStop(ct: CurrentTask, now: number): Promise<void> {
		const ctx = this.ctx;
		await this.transform(ct.filePath, (c) => mutate.appendToLine(c, ct.lineNumber, formatMarker("stop", now, ctx)));
		await this.timer.set(null);
	}

	async stopTimer(): Promise<void> {
		const ct = this.timer.get();
		if (!ct) {
			new Notice("No task running");
			return;
		}
		await this.appendStop(ct, this.nowEpoch());
		new Notice(`Stopped: ${ct.name}`);
		await this.updateFile(ct.filePath);
	}

	async completeTimer(): Promise<void> {
		const ct = this.timer.get();
		if (!ct) {
			new Notice("No task running");
			return;
		}
		const ctx = this.ctx;
		const now = this.nowEpoch();
		const ok = await this.transform(ct.filePath, (c) => actions.completeAt(c, ct.lineNumber, ctx, now));
		if (ok) {
			await this.timer.set(null);
			new Notice(`Completed: ${ct.name}`);
			await this.updateFile(ct.filePath);
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
		if (!existing) {
			await this.ensureParentFolder(path);
			const content = header ? mutate.insertAfterHeader(null, header, line) : mutate.appendToFile(null, line);
			try {
				await this.app.vault.create(path, content);
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e));
				return;
			}
		} else {
			await this.transform(path, (c) => (header ? mutate.insertAfterHeader(c, header, line) : mutate.appendToFile(c, line)));
		}
		new Notice(`Added: ${body.trim()}`);
		await this.updateFile(path);
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

	// ── date shift / set today ────────────────────────────────────────────────

	async shiftDate(task: Task, deltaDays: number): Promise<void> {
		if (task.dueDate !== null) {
			const newDate = formatEpoch(addDays(task.dueDate, deltaDays), this.settings.formats.date);
			if (await this.replaceLineDate(task, newDate)) return;
		}
		await this.shiftFrontmatterDue(task, deltaDays);
	}

	async setDateToday(task: Task): Promise<void> {
		const today = formatEpoch(todayEpoch(), this.settings.formats.date);
		if (task.dueDate !== null && (await this.replaceLineDate(task, today))) return;
		await this.setFrontmatterDueToday(task);
	}

	/** Replace the inline due date on the task's line; records an undo edit. */
	private async replaceLineDate(task: Task, newDateStr: string): Promise<boolean> {
		const ctx = this.ctx;
		const file = fileForPath(this.app, task.filePath);
		if (!file) return false;
		let edit: LineEdit | null = null;
		await this.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const ln = lines[task.lineNumber - 1];
			if (ln === undefined) return content;
			const replaced = replaceInlineDueDate(ln, ctx, newDateStr);
			if (replaced === null || replaced === ln) return content;
			edit = { filePath: task.filePath, lineNumber: task.lineNumber, oldLine: ln, newLine: replaced };
			lines[task.lineNumber - 1] = replaced;
			return lines.join("\n");
		});
		if (edit) {
			this.pushUndo([edit]);
			await this.updateFile(task.filePath);
			return true;
		}
		return false;
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
		if (changed) await this.updateFile(task.filePath);
		else new Notice("No due date to shift");
	}

	private async setFrontmatterDueToday(task: Task): Promise<void> {
		const file = fileForPath(this.app, task.filePath);
		if (!file) return;
		const dueKey = this.settings.frontmatter.dueKey;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm[dueKey] = formatEpoch(todayEpoch(), "%Y-%m-%d");
		});
		await this.updateFile(task.filePath);
	}

	// ── undo / redo (date edits only) ───────────────────────────────────────────

	/** Re-read each distinct file touched by a batch of edits (undo/redo). */
	private async updateEditedFiles(edits: LineEdit[]): Promise<void> {
		const paths = new Set(edits.map((e) => e.filePath));
		for (const path of paths) await this.updateFile(path);
	}

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
		if (await this.applyEdits(edits, "undo")) {
			this.redoStack.push(edits);
			await this.updateEditedFiles(edits);
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
		if (await this.applyEdits(edits, "redo")) {
			this.undoStack.push(edits);
			await this.updateEditedFiles(edits);
		} else {
			this.redoStack.push(edits);
		}
	}

	/** Apply each edit's target line, validating the current line matches the expected side. */
	private async applyEdits(edits: LineEdit[], dir: "undo" | "redo"): Promise<boolean> {
		const byFile = new Map<string, LineEdit[]>();
		for (const e of edits) {
			const arr = byFile.get(e.filePath);
			if (arr) arr.push(e);
			else byFile.set(e.filePath, [e]);
		}
		for (const [path, fileEdits] of byFile) {
			const file = fileForPath(this.app, path);
			if (!(file instanceof TFile)) {
				new Notice(`File not found: ${path}`);
				return false;
			}
			let mismatch = false;
			await this.app.vault.process(file, (content) => {
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
				return false;
			}
		}
		return true;
	}
}
