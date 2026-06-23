// view.ts — the Task Buffer custom view. Renders horizon-bucketed tasks as
// DOM rows with separated fields (date · time · duration · body · tags) and a
// native-looking checkbox — never the raw inline markup. Clicking a row opens
// its source line; a focused-view keyboard layer drives the verbs.

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { TaskEngine } from "./engine";
import { TaskbufferSettings } from "./config";
import { Task } from "./types";
import { todayEpoch } from "./dates";
import { DisplayRow, RenderOptions } from "./render/rows";

export const VIEW_TYPE_TASKBUFFER = "taskbuffer-view";

/** What the view needs from the plugin (kept narrow to avoid a circular import). */
export interface TaskbufferHost {
	engine: TaskEngine;
	getSettings(): TaskbufferSettings;
	openTaskSource(task: Task): Promise<void>;
	openCreateModal(): void;
	openTagFilter(current: string[], onApply: (tags: string[]) => void): void;
}

export class TaskbufferView extends ItemView {
	private host: TaskbufferHost;
	private showMarkers = false;
	private showUndated: boolean;
	private tagFilter: string[] = [];
	private selected = 0;
	private rows: DisplayRow[] = [];

	constructor(leaf: WorkspaceLeaf, host: TaskbufferHost) {
		super(leaf);
		this.host = host;
		this.showUndated = host.getSettings().showUndated;
	}

	getViewType(): string {
		return VIEW_TYPE_TASKBUFFER;
	}

	getDisplayText(): string {
		// "Task Buffer" is the plugin's proper name (matches manifest), not free UI copy.
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		return "Task Buffer";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("taskbuffer-view");
		this.contentEl.tabIndex = 0;
		this.registerDomEvent(this.contentEl, "keydown", (evt) => this.onKeyDown(evt));
		this.render();
		window.setTimeout(() => this.contentEl.focus(), 0);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	clearFilter(): void {
		this.tagFilter = [];
		this.showMarkers = false;
		this.showUndated = this.host.getSettings().showUndated;
		this.render();
	}

	setShowUndated(value: boolean): void {
		this.showUndated = value;
		this.render();
	}

	/** Rebuild the entire view from the engine's current task cache. */
	render(): void {
		const opts: RenderOptions = {
			today: todayEpoch(),
			showUndated: this.showUndated,
			showMarkers: this.showMarkers,
			tagFilter: this.tagFilter,
		};
		const sections = this.host.engine.sections(opts);
		const settings = this.host.getSettings();

		this.contentEl.empty();
		this.renderToolbar();

		const list = this.contentEl.createDiv({ cls: "taskbuffer-list" });
		this.rows = [];

		if (sections.length === 0) {
			list.createDiv({ cls: "taskbuffer-empty", text: "No open tasks." });
			return;
		}

		for (const section of sections) {
			list.createDiv({ cls: "taskbuffer-section", text: section.label });
			for (const row of section.rows) {
				const index = this.rows.length;
				this.rows.push(row);
				this.renderRow(list, row, index, settings);
			}
		}

		this.clampSelection();
		this.highlightSelection();
	}

	private renderToolbar(): void {
		const bar = this.contentEl.createDiv({ cls: "taskbuffer-toolbar" });
		const button = (icon: string, label: string, onClick: () => void, active = false): void => {
			const btn = bar.createEl("button", { cls: "taskbuffer-toolbar-button", attr: { "aria-label": label } });
			if (active) btn.addClass("is-active");
			setIcon(btn, icon);
			btn.createSpan({ text: label });
			btn.addEventListener("click", onClick);
		};
		button("plus", "New", () => this.host.openCreateModal());
		button("filter", this.tagFilter.length ? `Tags (${this.tagFilter.length})` : "Tags", () => this.openFilter(), this.tagFilter.length > 0);
		button("eye", this.showUndated ? "Undated: on" : "Undated: off", () => this.setShowUndated(!this.showUndated), this.showUndated);
		button("tag", this.showMarkers ? "Markers: on" : "Markers: off", () => {
			this.showMarkers = !this.showMarkers;
			this.render();
		}, this.showMarkers);
		button("rotate-ccw", "Reset", () => this.clearFilter());
		button("refresh-cw", "Refresh", () => void this.dispatchRefresh());
	}

	private renderRow(parent: HTMLElement, row: DisplayRow, index: number, settings: TaskbufferSettings): void {
		const el = parent.createDiv({ cls: "taskbuffer-row" });
		el.dataset.index = String(index);

		const checkbox = el.createEl("input", {
			cls: "task-list-item-checkbox taskbuffer-checkbox",
			attr: { type: "checkbox", "aria-label": "Complete task" },
		});
		checkbox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.runOn(index, (task) => this.host.engine.complete(task));
		});

		el.createSpan({ cls: "taskbuffer-date", text: row.dateText });
		el.createSpan({ cls: "taskbuffer-time", text: row.timeText });
		el.createSpan({ cls: "taskbuffer-duration", text: row.durationText });

		const main = el.createDiv({ cls: "taskbuffer-main" });
		main.createSpan({ cls: "taskbuffer-body", text: row.body });
		if (row.tags.length > 0) {
			const tagsEl = main.createSpan({ cls: "taskbuffer-tags" });
			for (const tag of row.tags) {
				tagsEl.createSpan({ cls: "taskbuffer-tag", text: settings.formats.tagPrefix + tag });
			}
		}
		if (this.showMarkers && row.markers.length > 0) {
			const markersEl = main.createSpan({ cls: "taskbuffer-markers" });
			for (const m of row.markers) {
				const text = `${settings.formats.markerPrefix}${m.kind} ${m.date}${m.time ? " " + m.time : ""}`;
				markersEl.createSpan({ cls: "taskbuffer-marker", text });
			}
		}

		el.addEventListener("click", () => {
			this.selected = index;
			this.highlightSelection();
		});
		el.addEventListener("dblclick", () => void this.runOn(index, (task) => this.host.openTaskSource(task)));
	}

	private openFilter(): void {
		this.host.openTagFilter(this.tagFilter, (tags) => {
			this.tagFilter = tags;
			this.render();
		});
	}

	// ── selection ──────────────────────────────────────────────────────────

	private clampSelection(): void {
		if (this.rows.length === 0) this.selected = 0;
		else if (this.selected >= this.rows.length) this.selected = this.rows.length - 1;
		else if (this.selected < 0) this.selected = 0;
	}

	private highlightSelection(): void {
		const els = this.contentEl.querySelectorAll(".taskbuffer-row");
		els.forEach((el, i) => el.toggleClass("is-selected", i === this.selected));
		const current = els[this.selected];
		if (current instanceof HTMLElement) current.scrollIntoView({ block: "nearest" });
	}

	private move(delta: number): void {
		if (this.rows.length === 0) return;
		this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
		this.highlightSelection();
	}

	// ── action dispatch ──────────────────────────────────────────────────────

	private async runOn(index: number, fn: (task: Task) => Promise<void> | void): Promise<void> {
		const row = this.rows[index];
		if (!row) return;
		await fn(row.task);
		this.render();
	}

	private async dispatchRefresh(): Promise<void> {
		await this.host.engine.refresh();
		this.render();
	}

	private selectedTask(): Task | null {
		return this.rows[this.selected]?.task ?? null;
	}

	private onKeyDown(evt: KeyboardEvent): void {
		const engine = this.host.engine;
		const task = this.selectedTask();
		const need = (fn: (t: Task) => Promise<void> | void): void => {
			if (task) void this.runOn(this.selected, fn);
		};

		switch (evt.key) {
			case "j":
			case "ArrowDown":
				this.move(1);
				break;
			case "k":
			case "ArrowUp":
				this.move(-1);
				break;
			case "Enter":
			case "o":
				if (task) void this.host.openTaskSource(task);
				break;
			case "c":
				need((t) => engine.complete(t));
				break;
			case "x":
				need((t) => engine.check(t));
				break;
			case "d":
				need((t) => engine.defer(t));
				break;
			case "i":
				need((t) => engine.markIrrelevant(t));
				break;
			case "u":
				need((t) => engine.unsetIrrelevant(t));
				break;
			case "b":
				need((t) => engine.startTimer(t));
				break;
			case "S":
				void engine.stopTimer().then(() => this.render());
				break;
			case "t":
				need((t) => engine.setDateToday(t));
				break;
			case "m":
				this.showMarkers = !this.showMarkers;
				this.render();
				break;
			case "/":
			case "#":
				evt.preventDefault();
				this.openFilter();
				break;
			case "r":
				void this.dispatchRefresh();
				break;
			case "z":
				void engine.undo().then(() => this.render());
				break;
			case "Z":
				void engine.redo().then(() => this.render());
				break;
			case "ArrowLeft":
				if (evt.shiftKey) need((t) => engine.shiftDate(t, -1));
				else return;
				break;
			case "ArrowRight":
				if (evt.shiftKey) need((t) => engine.shiftDate(t, 1));
				else return;
				break;
			default:
				return;
		}
		evt.preventDefault();
	}
}
