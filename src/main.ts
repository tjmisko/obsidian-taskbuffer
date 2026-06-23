import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, WorkspaceLeaf, debounce } from "obsidian";
import { TaskbufferSettings, mergeSettings } from "./config";
import { TaskEngine, TimerStore } from "./engine";
import { CurrentTask } from "./state";
import { Task } from "./types";
import { buildParseContext, parseTask } from "./parse/parse";
import { fileForPath } from "./scan";
import {
	TaskbufferView,
	TaskbufferFullView,
	VIEW_TYPE_TASKBUFFER,
	VIEW_TYPE_TASKBUFFER_FULL,
	TaskbufferHost,
} from "./view";
import { TaskbufferSettingTab } from "./settings";
import { CreateTaskModal, TagFilterModal } from "./modals";
import { perfStart, setPerfEnabled } from "./perf";

interface PersistedData {
	settings: Partial<TaskbufferSettings>;
	timer: CurrentTask | null;
}

export default class TaskbufferPlugin extends Plugin implements TaskbufferHost {
	settings!: TaskbufferSettings;
	engine!: TaskEngine;
	private timer: CurrentTask | null = null;
	private statusBar!: HTMLElement;
	private scheduleRefresh = debounce(() => void this.refreshAndRender(), 400, true);

	async onload(): Promise<void> {
		await this.loadState();
		setPerfEnabled(this.settings.debugTiming);

		const timerStore: TimerStore = {
			get: () => this.timer,
			set: async (t) => {
				this.timer = t;
				await this.saveState();
				this.updateStatusBar();
			},
		};
		this.engine = new TaskEngine(this.app, this.settings, timerStore);

		this.registerView(VIEW_TYPE_TASKBUFFER, (leaf) => new TaskbufferView(leaf, this));
		this.registerView(VIEW_TYPE_TASKBUFFER_FULL, (leaf) => new TaskbufferFullView(leaf, this));
		this.addRibbonIcon("list-checks", "Open task buffer", () => void this.activateView());
		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar();

		this.addCommands();
		this.addSettingTab(new TaskbufferSettingTab(this.app, this));

		// Keep startup light: scan once and wire file events only after layout is
		// ready (Obsidian fires `create` for every file during vault init).
		this.app.workspace.onLayoutReady(() => {
			const end = perfStart("initial refresh (onLayoutReady)");
			void this.refreshAndRender().then(() => end({ tasks: this.engine.tasks.length }));
			this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
			this.registerEvent(this.app.vault.on("modify", () => this.scheduleRefresh()));
			this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
			this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
			this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
		});
	}

	onunload(): void {
		// Intentionally empty: do not detach leaves of our view type (Obsidian
		// reinitializes them on update; detaching would disrupt the user's layout).
	}

	// ── TaskbufferHost ─────────────────────────────────────────────────────────

	getSettings(): TaskbufferSettings {
		return this.settings;
	}

	async openTaskSource(task: Task): Promise<void> {
		const file = fileForPath(this.app, task.filePath);
		if (!file) {
			new Notice(`File not found: ${task.filePath}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file);
		if (leaf.view instanceof MarkdownView) {
			const editor = leaf.view.editor;
			const line = Math.max(0, task.lineNumber - 1);
			editor.setCursor({ line, ch: 0 });
			editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		}
	}

	openCreateModal(): void {
		new CreateTaskModal(this.app, (body) => void this.engine.create(body).then(() => this.renderViews())).open();
	}

	openTagFilter(current: string[], onApply: (tags: string[]) => void): void {
		new TagFilterModal(this.app, this.engine.allTags(), current, onApply).open();
	}

	// ── persistence ─────────────────────────────────────────────────────────────

	private async loadState(): Promise<void> {
		const data = (await this.loadData()) as PersistedData | null;
		this.settings = mergeSettings(data?.settings ?? {});
		this.timer = data?.timer ?? null;
	}

	private async saveState(): Promise<void> {
		const data: PersistedData = { settings: this.settings, timer: this.timer };
		await this.saveData(data);
	}

	/** Persist settings only (no re-scan) — used while typing in the settings tab. */
	async persistSettings(): Promise<void> {
		this.engine.settings = this.settings;
		await this.saveState();
	}

	/** Persist settings and re-scan/re-render. */
	async saveSettings(): Promise<void> {
		await this.persistSettings();
		await this.refreshAndRender();
	}

	// ── view plumbing ─────────────────────────────────────────────────────────

	private async activateView(): Promise<void> {
		const end = perfStart("activateView (sidebar)");
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_TASKBUFFER)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_TASKBUFFER, active: true });
		}
		await workspace.revealLeaf(leaf);
		end();
	}

	private async activateFullView(): Promise<void> {
		const end = perfStart("activateView (full)");
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_TASKBUFFER_FULL)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_TASKBUFFER_FULL, active: true });
		}
		await workspace.revealLeaf(leaf);
		end();
	}

	private get allLeaves(): WorkspaceLeaf[] {
		const ws = this.app.workspace;
		return [...ws.getLeavesOfType(VIEW_TYPE_TASKBUFFER), ...ws.getLeavesOfType(VIEW_TYPE_TASKBUFFER_FULL)];
	}

	private renderViews(): void {
		for (const leaf of this.allLeaves) {
			if (leaf.view instanceof TaskbufferView || leaf.view instanceof TaskbufferFullView) leaf.view.render();
		}
	}

	async refreshAndRender(): Promise<void> {
		await this.engine.refresh();
		this.renderViews();
		this.updateStatusBar();
	}

	private updateStatusBar(): void {
		this.statusBar.setText(this.timer ? `▶ ${this.timer.name}` : "");
	}

	private clearFiltersInViews(): void {
		for (const leaf of this.allLeaves) {
			if (leaf.view instanceof TaskbufferView || leaf.view instanceof TaskbufferFullView) leaf.view.clearFilter();
		}
	}

	// ── commands ─────────────────────────────────────────────────────────────

	private taskAtCursor(editor: Editor, info: MarkdownFileInfo): Task | null {
		const file = info.file;
		if (!file) return null;
		const lineNumber = editor.getCursor().line + 1;
		const text = editor.getLine(lineNumber - 1);
		const ctx = buildParseContext(this.settings, false);
		return parseTask({ path: file.path, lineNumber, text }, ctx);
	}

	private addCommands(): void {
		this.addCommand({ id: "open", name: "Open in sidebar", callback: () => void this.activateView() });
		this.addCommand({ id: "open-full", name: "Open full page", callback: () => void this.activateFullView() });
		this.addCommand({ id: "refresh", name: "Refresh tasks", callback: () => void this.refreshAndRender() });
		this.addCommand({ id: "new-task", name: "New task", callback: () => this.openCreateModal() });
		this.addCommand({ id: "clear-filters", name: "Clear filters", callback: () => this.clearFiltersInViews() });
		this.addCommand({
			id: "stop-timer",
			name: "Stop running timer",
			callback: () => void this.engine.stopTimer().then(() => this.renderViews()),
		});
		this.addCommand({
			id: "complete-timer",
			name: "Complete running timer",
			callback: () => void this.engine.completeTimer().then(() => this.renderViews()),
		});

		// Editor commands operate on the task under the cursor.
		const editorVerb = (id: string, name: string, run: (task: Task) => Promise<void>): void => {
			this.addCommand({
				id,
				name,
				editorCheckCallback: (checking: boolean, editor: Editor, info: MarkdownFileInfo) => {
					const task = this.taskAtCursor(editor, info);
					if (!task) return false;
					if (!checking) void run(task).then(() => this.renderViews());
					return true;
				},
			});
		};
		editorVerb("complete-at-cursor", "Complete task at cursor", (t) => this.engine.complete(t));
		editorVerb("check-at-cursor", "Check off task at cursor (no marker)", (t) => this.engine.check(t));
		editorVerb("defer-at-cursor", "Defer task at cursor", (t) => this.engine.defer(t));
		editorVerb("irrelevant-at-cursor", "Mark task at cursor irrelevant", (t) => this.engine.markIrrelevant(t));
		editorVerb("unset-irrelevant-at-cursor", "Undo irrelevant at cursor", (t) => this.engine.unsetIrrelevant(t));
		editorVerb("start-timer-at-cursor", "Start timer for task at cursor", (t) => this.engine.startTimer(t));
		editorVerb("set-due-today-at-cursor", "Set due date to today at cursor", (t) => this.engine.setDateToday(t));
		editorVerb("shift-due-back-at-cursor", "Shift due date back one day", (t) => this.engine.shiftDate(t, -1));
		editorVerb("shift-due-forward-at-cursor", "Shift due date forward one day", (t) => this.engine.shiftDate(t, 1));
	}
}
