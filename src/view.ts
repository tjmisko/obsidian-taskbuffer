// view.ts — the Taskbuffer custom views. A virtualized, 100%-keyboard list:
// horizon-bucketed tasks render as compact rows of a fixed, uniform height (the
// body is vertically centered and may wrap to two lines), but only the rows in
// (and just around) the viewport are ever in the DOM, so render time is constant
// no matter how many thousand tasks the vault holds. The selected task's full
// body, tags, and parsed marker history show in a pinned detail strip. Two
// concrete views share this base: a compact sidebar dock view and a roomy
// full-page (main-area) view.

import { ItemView, WorkspaceLeaf } from "obsidian";
import { TaskEngine } from "./engine";
import { TaskbufferSettings } from "./config";
import { Task } from "./types";
import { todayEpoch } from "./dates";
import { DisplayRow, RenderOptions } from "./render/rows";
import { describeMarkers } from "./render/markers";
import { tokenizeInline } from "./render/inline";
import { perfStart } from "./perf";

export const VIEW_TYPE_TASKBUFFER = "taskbuffer-view";
export const VIEW_TYPE_TASKBUFFER_FULL = "taskbuffer-full-view";

export type LayoutMode = "sidebar" | "full";

/** What the view needs from the plugin (kept narrow to avoid a circular import). */
export interface TaskbufferHost {
	engine: TaskEngine;
	getSettings(): TaskbufferSettings;
	openTaskSource(task: Task): Promise<void>;
	openCreateModal(): void;
	openTagFilter(current: string[], onApply: (tags: string[]) => void): void;
}

/** A flat, positioned render item. `rowIndex === undefined` means a section header. */
interface VItem {
	top: number;
	height: number;
	section?: string;
	rowIndex?: number;
}

const OVERSCAN_ROWS = 8;
/** Below this container width (px), rows stack tags/date under the body (phones, sidebar). */
const NARROW_BREAKPOINT = 480;

/** Rows shown in the keyboard-help overlay. */
const HELP_KEYS: Array<[string, string]> = [
	["j / k", "move down / up"],
	["g / G", "jump to top / bottom"],
	["enter / o", "open task source"],
	["c", "complete"],
	["x", "check off (no marker)"],
	["d", "defer"],
	["t", "due today"],
	["⇧← / ⇧→", "shift due back / forward a day"],
	["b / S", "start / stop timer"],
	["i / u", "mark irrelevant / undo"],
	["m", "toggle detail strip"],
	["U", "toggle undated tasks"],
	["n", "new task"],
	["/ or #", "filter by tag"],
	["r", "refresh"],
	["z / Z", "undo / redo date edit"],
	["esc", "clear filters / close help"],
	["?", "toggle this help"],
];

abstract class TaskbufferViewBase extends ItemView {
	protected host: TaskbufferHost;
	private showHelp = false;
	private showDetail = true;
	private showUndated: boolean;
	private tagFilter: string[] = [];
	private selected = 0;

	// Virtual-list state.
	private rows: DisplayRow[] = []; // selectable task rows, in display order
	private items: VItem[] = []; // flat section/row items with absolute offsets
	private rowTop: number[] = []; // rowIndex -> top offset (for scroll-into-view)
	private totalHeight = 0;
	private rowH = 0; // measured uniform row height
	private sectionH = 0; // measured section-header height
	private renderedStart = -1;
	private renderedEnd = -1;
	private scrollRaf = 0;
	private settings!: TaskbufferSettings;

	// Persistent shell elements (built once in onOpen, never emptied wholesale).
	private filterNoteEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private sizerEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private helpEl: HTMLElement | null = null;

	abstract layoutMode(): LayoutMode;

	constructor(leaf: WorkspaceLeaf, host: TaskbufferHost) {
		super(leaf);
		this.host = host;
		this.showUndated = host.getSettings().showUndated;
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		const end = perfStart(`onOpen[${this.layoutMode()}]`);
		this.contentEl.addClass("taskbuffer-view");
		this.contentEl.addClass(this.layoutMode() === "full" ? "is-full" : "is-sidebar");
		this.contentEl.tabIndex = 0;

		this.filterNoteEl = this.contentEl.createDiv({ cls: "taskbuffer-filter-note" });
		this.filterNoteEl.hide();
		this.viewportEl = this.contentEl.createDiv({ cls: "taskbuffer-viewport" });
		this.sizerEl = this.viewportEl.createDiv({ cls: "taskbuffer-sizer" });
		this.emptyEl = this.viewportEl.createDiv({ cls: "taskbuffer-empty", text: "No open tasks." });
		this.emptyEl.hide();
		this.detailEl = this.contentEl.createDiv({ cls: "taskbuffer-detail" });

		this.registerDomEvent(this.contentEl, "keydown", (evt) => this.onKeyDown(evt));
		this.registerDomEvent(this.viewportEl, "scroll", () => this.onScroll());

		this.render();
		window.setTimeout(() => {
			this.contentEl.focus();
			this.onResize(); // viewport now has a real size; narrow state may flip
		}, 0);
		end();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	onResize(): void {
		// Crossing the narrow breakpoint changes the uniform row height, which
		// invalidates the whole item layout; otherwise repainting the window is enough.
		const wasNarrow = this.contentEl.hasClass("is-narrow");
		this.updateNarrow();
		if (this.contentEl.hasClass("is-narrow") !== wasNarrow) this.render();
		else this.renderWindow(true);
	}

	clearFilter(): void {
		this.tagFilter = [];
		this.showUndated = this.host.getSettings().showUndated;
		this.render();
	}

	// ── full rebuild (data changed) ────────────────────────────────────────────

	/** Recompute the item layout from the engine's task cache, then paint the window. */
	render(): void {
		const end = perfStart(`render[${this.layoutMode()}]`);
		this.settings = this.host.getSettings();
		this.updateNarrow();
		this.measure();

		const buildEnd = perfStart("  sections");
		const opts: RenderOptions = {
			today: todayEpoch(),
			showUndated: this.showUndated,
			showMarkers: true, // carry markers so the detail strip can show history
			tagFilter: this.tagFilter,
		};
		const sections = this.host.engine.sections(opts);
		buildEnd({ sections: sections.length });

		// Flatten to positioned items.
		this.rows = [];
		this.items = [];
		this.rowTop = [];
		let top = 0;
		for (const section of sections) {
			this.items.push({ top, height: this.sectionH, section: section.label });
			top += this.sectionH;
			for (const row of section.rows) {
				const rowIndex = this.rows.length;
				this.rows.push(row);
				this.rowTop.push(top);
				this.items.push({ top, height: this.rowH, rowIndex });
				top += this.rowH;
			}
		}
		this.totalHeight = top;
		this.sizerEl.style.height = `${top}px`;

		if (this.tagFilter.length > 0) {
			this.filterNoteEl.setText(`Filtered: ${this.tagFilter.map((t) => this.settings.formats.tagPrefix + t).join(" ")}`);
			this.filterNoteEl.show();
		} else {
			this.filterNoteEl.hide();
		}
		this.emptyEl.toggle(this.rows.length === 0);

		this.clampSelection();
		this.renderWindow(true);
		this.updateDetail();
		this.renderHelp();
		end({ rows: this.rows.length });
	}

	/**
	 * Measure uniform row/section heights from real probe elements (handles
	 * zoom/theme/platform). The probe row carries the worst-case content the
	 * layout allows — a two-line body plus a tag and a date — and every painted
	 * row gets this measured height inline, so the virtualizer's pitch and the
	 * painted height cannot disagree (they did on iOS, where the old CSS calc
	 * height didn't resolve and rows auto-sized taller than the pitch).
	 */
	private measure(): void {
		const probe = this.viewportEl.createDiv({ cls: "taskbuffer-probe" });
		const section = probe.createDiv({ cls: "taskbuffer-section", text: "Probe" });
		const row = probe.createDiv({ cls: "taskbuffer-row" });
		row.createEl("input", { cls: "task-list-item-checkbox taskbuffer-checkbox", attr: { type: "checkbox" } });
		const body = row.createSpan({ cls: "taskbuffer-body" });
		body.appendText("Probe");
		body.createEl("br");
		body.appendText("Probe");
		row.createSpan({ cls: "taskbuffer-tags" }).createSpan({ cls: "taskbuffer-tag", text: "#probe" });
		row.createSpan({ cls: "taskbuffer-meta" }).createSpan({ cls: "taskbuffer-date", text: "2026-01-01" });
		this.sectionH = section.offsetHeight || 22;
		this.rowH = row.offsetHeight || 44;
		probe.remove();
		console.debug("taskbuffer: measure", {
			rowH: this.rowH,
			sectionH: this.sectionH,
			width: this.viewportEl.clientWidth,
			narrow: this.contentEl.hasClass("is-narrow"),
		});
	}

	/** Stack tags/date under the body when the pane is too narrow for one line. */
	private updateNarrow(): void {
		const width = this.viewportEl.clientWidth;
		if (width > 0) this.contentEl.toggleClass("is-narrow", width < NARROW_BREAKPOINT);
	}

	// ── windowed paint (scroll / selection) ────────────────────────────────────

	private onScroll(): void {
		if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
		this.scrollRaf = requestAnimationFrame(() => {
			this.scrollRaf = 0;
			this.renderWindow(false);
		});
	}

	/** Smallest item index whose bottom edge is below `y`. Items are sorted by top. */
	private firstVisible(y: number): number {
		let lo = 0;
		let hi = this.items.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const it = this.items[mid] as VItem;
			if (it.top + it.height > y) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	}

	/** Render only the items inside the viewport (+overscan). Cheap; called every frame. */
	private renderWindow(force: boolean): void {
		if (this.rows.length === 0) {
			this.sizerEl.empty();
			this.renderedStart = this.renderedEnd = -1;
			return;
		}
		const scrollTop = this.viewportEl.scrollTop;
		const vh = this.viewportEl.clientHeight || 600;
		const overscan = OVERSCAN_ROWS * this.rowH;
		const start = this.firstVisible(scrollTop - overscan);
		const bottom = scrollTop + vh + overscan;
		let end = start;
		while (end < this.items.length && (this.items[end] as VItem).top < bottom) end += 1;

		if (!force && start === this.renderedStart && end === this.renderedEnd) return;
		this.renderedStart = start;
		this.renderedEnd = end;

		const end_ = perfStart("  window");
		this.sizerEl.empty();
		for (let i = start; i < end; i++) {
			const it = this.items[i] as VItem;
			if (it.rowIndex === undefined) this.renderSection(it);
			else this.renderRow(it);
		}
		end_({ items: end - start });
	}

	private renderSection(it: VItem): void {
		const el = this.sizerEl.createDiv({ cls: "taskbuffer-section", text: it.section ?? "" });
		el.style.top = `${it.top}px`;
		el.style.height = `${it.height}px`;
	}

	private renderRow(it: VItem): void {
		const index = it.rowIndex as number;
		const row = this.rows[index] as DisplayRow;
		const el = this.sizerEl.createDiv({ cls: "taskbuffer-row" });
		el.style.top = `${it.top}px`;
		el.style.height = `${it.height}px`;
		el.dataset.index = String(index);
		if (index === this.selected) el.addClass("is-selected");

		const checkbox = el.createEl("input", {
			cls: "task-list-item-checkbox taskbuffer-checkbox",
			attr: { type: "checkbox", "aria-label": "Complete task" },
		});
		checkbox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.runOn(index, (task) => this.host.engine.complete(task));
		});

		const bodyEl = el.createSpan({ cls: "taskbuffer-body" });
		this.renderBody(bodyEl, row.body, row.task.filePath);

		if (row.tags.length > 0) {
			const tagsEl = el.createSpan({ cls: "taskbuffer-tags" });
			for (const tag of row.tags) {
				tagsEl.createSpan({ cls: "taskbuffer-tag", text: this.settings.formats.tagPrefix + tag });
			}
		}

		const meta = el.createSpan({ cls: "taskbuffer-meta" });
		if (row.dateText) meta.createSpan({ cls: "taskbuffer-date", text: row.dateText });
		if (row.timeText) meta.createSpan({ cls: "taskbuffer-time", text: row.timeText });
		if (row.durationText) meta.createSpan({ cls: "taskbuffer-duration", text: row.durationText });

		el.addEventListener("click", () => this.select(index));
		el.addEventListener("dblclick", () => void this.runOn(index, (task) => this.host.openTaskSource(task)));
	}

	/**
	 * Paint a task body into `parent`, rendering its inline markdown to themed
	 * DOM (wikilinks, code spans, emphasis, links) instead of showing raw source.
	 * Links are clickable — wikilinks navigate via `sourcePath`, plain links open
	 * externally — and stop propagation so a click on a link doesn't also select
	 * the row.
	 */
	private renderBody(parent: HTMLElement, body: string, sourcePath: string): void {
		for (const tok of tokenizeInline(body)) {
			switch (tok.kind) {
				case "text":
					parent.appendText(tok.text);
					break;
				case "code":
					parent.createEl("code", { cls: "taskbuffer-md-code", text: tok.text });
					break;
				case "bold":
					parent.createEl("strong", { text: tok.text });
					break;
				case "italic":
					parent.createEl("em", { text: tok.text });
					break;
				case "strike":
					parent.createEl("del", { text: tok.text });
					break;
				case "wikilink": {
					const a = parent.createEl("a", { cls: "internal-link taskbuffer-md-link", text: tok.text, href: tok.target });
					a.addEventListener("click", (evt) => {
						evt.preventDefault();
						evt.stopPropagation();
						void this.app.workspace.openLinkText(tok.target, sourcePath, evt.ctrlKey || evt.metaKey);
					});
					break;
				}
				case "link": {
					const a = parent.createEl("a", { cls: "external-link taskbuffer-md-link", text: tok.text, href: tok.href });
					a.addEventListener("click", (evt) => {
						evt.preventDefault();
						evt.stopPropagation();
						window.open(tok.href, "_blank");
					});
					break;
				}
			}
		}
	}

	// ── detail strip (selected task) ───────────────────────────────────────────

	private updateDetail(): void {
		this.detailEl.empty();
		this.detailEl.toggle(this.showDetail);
		if (!this.showDetail) return;
		const row = this.rows[this.selected];
		if (!row) {
			this.detailEl.createSpan({ cls: "taskbuffer-detail-empty", text: "—" });
			return;
		}

		const detailBodyEl = this.detailEl.createDiv({ cls: "taskbuffer-detail-body" });
		this.renderBody(detailBodyEl, row.body, row.task.filePath);

		const meta = this.detailEl.createDiv({ cls: "taskbuffer-detail-meta" });
		if (row.dateText) meta.createSpan({ cls: "taskbuffer-date", text: row.dateText });
		if (row.timeText) meta.createSpan({ cls: "taskbuffer-time", text: row.timeText });
		if (row.durationText) meta.createSpan({ cls: "taskbuffer-duration", text: row.durationText });
		for (const tag of row.tags) {
			meta.createSpan({ cls: "taskbuffer-tag", text: this.settings.formats.tagPrefix + tag });
		}

		const log = describeMarkers(row.markers);
		if (log.length > 0) {
			const logEl = this.detailEl.createDiv({ cls: "taskbuffer-log" });
			for (const entry of log) {
				const item = logEl.createSpan({ cls: "taskbuffer-log-entry" });
				item.dataset.kind = entry.kind;
				item.createSpan({ cls: "taskbuffer-log-glyph", text: entry.glyph });
				item.createSpan({ cls: "taskbuffer-log-label", text: entry.label });
				if (entry.when) item.createSpan({ cls: "taskbuffer-log-when", text: entry.when });
			}
		}
	}

	private renderHelp(): void {
		if (this.helpEl) {
			this.helpEl.remove();
			this.helpEl = null;
		}
		if (!this.showHelp) return;
		const overlay = this.contentEl.createDiv({ cls: "taskbuffer-help" });
		overlay.createDiv({ cls: "taskbuffer-help-title", text: "Keyboard" });
		const grid = overlay.createDiv({ cls: "taskbuffer-help-grid" });
		for (const [keys, desc] of HELP_KEYS) {
			grid.createSpan({ cls: "taskbuffer-help-keys", text: keys });
			grid.createSpan({ cls: "taskbuffer-help-desc", text: desc });
		}
		this.helpEl = overlay;
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

	/** Move selection to a specific row, scroll it into view, repaint window + detail. */
	private select(index: number): void {
		if (this.rows.length === 0) return;
		this.selected = Math.max(0, Math.min(this.rows.length - 1, index));
		this.scrollSelectedIntoView();
		this.renderWindow(true);
		this.updateDetail();
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
	}

	private scrollSelectedIntoView(): void {
		const top = this.rowTop[this.selected];
		if (top === undefined) return;
		const vh = this.viewportEl.clientHeight || 600;
		const scrollTop = this.viewportEl.scrollTop;
		if (top < scrollTop) this.viewportEl.scrollTop = top;
		else if (top + this.rowH > scrollTop + vh) this.viewportEl.scrollTop = top + this.rowH - vh;
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

		// The help overlay swallows everything except its own dismissal.
		if (this.showHelp && evt.key !== "?" && evt.key !== "Escape") {
			evt.preventDefault();
			return;
		}

		switch (evt.key) {
			case "j":
			case "ArrowDown":
				this.move(1);
				break;
			case "k":
			case "ArrowUp":
				this.move(-1);
				break;
			case "g":
				this.select(0);
				break;
			case "G":
				this.select(this.rows.length - 1);
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
				this.showDetail = !this.showDetail;
				this.updateDetail();
				this.renderWindow(true);
				break;
			case "U":
				this.showUndated = !this.showUndated;
				this.render();
				break;
			case "n":
				this.host.openCreateModal();
				break;
			case "/":
			case "#":
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
			case "?":
				this.showHelp = !this.showHelp;
				this.renderHelp();
				break;
			case "Escape":
				if (this.showHelp) {
					this.showHelp = false;
					this.renderHelp();
				} else {
					this.clearFilter();
				}
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

/** Compact view that lives in a side dock. */
export class TaskbufferView extends TaskbufferViewBase {
	layoutMode(): LayoutMode {
		return "sidebar";
	}

	getViewType(): string {
		return VIEW_TYPE_TASKBUFFER;
	}

	getDisplayText(): string {
		// "Taskbuffer" is the plugin's proper name (matches manifest), not free UI copy.
		return "Taskbuffer";
	}
}

/** Roomy view that takes over the main editor area. */
export class TaskbufferFullView extends TaskbufferViewBase {
	layoutMode(): LayoutMode {
		return "full";
	}

	getViewType(): string {
		return VIEW_TYPE_TASKBUFFER_FULL;
	}

	getDisplayText(): string {
		return "Taskbuffer";
	}
}
