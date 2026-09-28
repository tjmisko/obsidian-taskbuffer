// view.ts — the Taskbuffer custom views. A virtualized, 100%-keyboard list:
// horizon-bucketed tasks render as compact rows of a fixed, uniform height (the
// body is vertically centered and may wrap to two lines), but only the rows in
// (and just around) the viewport are ever in the DOM, so render time is constant
// no matter how many thousand tasks the vault holds. The selected task's full
// body, tags, parsed marker history, and touch-sized action buttons show in a
// pinned detail strip; the current section's header stays pinned over the top
// of the list; a long press (touch) or right-click opens an action sheet. Two
// concrete views share this base: a compact sidebar dock view and a roomy
// full-page (main-area) view.

import { ItemView, Menu, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { TaskEngine } from "./engine";
import { TaskbufferSettings } from "./config";
import { Task } from "./types";
import { addDays, todayEpoch } from "./dates";
import { DisplayRow, RenderOptions } from "./render/rows";
import { describeMarkers } from "./render/markers";
import { tokenizeInline } from "./render/inline";
import {
	Measurement,
	SectionMark,
	VItem,
	firstVisibleItem,
	resolveMeasurement,
	stickyHeader,
} from "./render/virtual";
import { LONG_PRESS_DELAY_MS, LONG_PRESS_SLOP_PX, LongPressTracker } from "./gesture";
import { attachDateOverlay, openDatePicker } from "./datepicker";
import { DeferDateModal } from "./modals";
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

const OVERSCAN_ROWS = 8;
/** Below this container width (px), rows stack tags/date under the body (phones, sidebar). */
const NARROW_BREAKPOINT = 480;
/** A contextmenu this soon after a touch long press is the same gesture (Android fires both). */
const LONG_PRESS_CONTEXTMENU_GRACE_MS = 1000;
/** Same pulse Obsidian core fires when its own long presses engage. */
const LONG_PRESS_HAPTIC_MS = 200;

/**
 * Haptic tick. Obsidian's iOS app backs navigator.vibrate with the native
 * haptic engine (core calls it for its own long presses), Android vibrates, and
 * desktop has no motor — so feature-detect and never let it throw.
 */
function haptic(ms: number): void {
	if (typeof navigator.vibrate !== "function") return;
	try {
		navigator.vibrate(ms);
	} catch {
		/* unsupported: haptics are a nicety */
	}
}

/** Rows shown in the keyboard-help overlay. */
const HELP_KEYS: Array<[string, string]> = [
	["j / k", "move down / up"],
	["g / G", "jump to top / bottom"],
	["enter / o", "open task source"],
	["c", "complete"],
	["x", "check off (no marker)"],
	["d", "defer (keep date)"],
	["D", "defer to a date…"],
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
	private sections: SectionMark[] = []; // section headers, for the pinned header
	private totalHeight = 0;
	private rowH = 0; // measured uniform row height
	private sectionH = 0; // measured section-header height
	/** Last measurement taken while the view was visible; survives hidden renders. */
	private trustedMeasurement: Measurement | null = null;
	/** Set when a render had to lay out without a trustworthy measurement. */
	private measureStale = true;
	private sizerTop = 0; // sizer's offset inside the scroll content (viewport padding)
	private lastWidth = 0; // viewport width at the last relayout (0 = was hidden)
	private relayoutRaf = 0;
	private renderedStart = -1;
	private renderedEnd = -1;
	private scrollRaf = 0;
	private settings!: TaskbufferSettings;

	// Persistent shell elements (built once in onOpen, never emptied wholesale).
	private filterNoteEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private sizerEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private stickyEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private helpEl: HTMLElement | null = null;

	// Touch long press: which row is held, and when a press last fired.
	private longPress = new LongPressTracker({
		delayMs: LONG_PRESS_DELAY_MS,
		slopPx: LONG_PRESS_SLOP_PX,
		setTimer: (fn, ms) => window.setTimeout(fn, ms),
		clearTimer: (id) => window.clearTimeout(id),
		onFire: (x, y) => this.onLongPress(x, y),
	});
	private pressIndex: number | null = null;
	private pressEl: HTMLElement | null = null;
	private lastLongPressAt = 0;

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
		const listEl = this.contentEl.createDiv({ cls: "taskbuffer-list" });
		this.viewportEl = listEl.createDiv({ cls: "taskbuffer-viewport" });
		this.sizerEl = this.viewportEl.createDiv({ cls: "taskbuffer-sizer" });
		this.emptyEl = this.viewportEl.createDiv({ cls: "taskbuffer-empty", text: "No open tasks." });
		this.emptyEl.hide();
		// Outside the scroller, so it stays put while the rows move under it.
		this.stickyEl = listEl.createDiv({ cls: "taskbuffer-section taskbuffer-sticky", attr: { "aria-hidden": "true" } });
		this.stickyEl.hide();
		this.detailEl = this.contentEl.createDiv({ cls: "taskbuffer-detail" });

		this.registerDomEvent(this.contentEl, "keydown", (evt) => this.onKeyDown(evt));
		this.registerDomEvent(this.viewportEl, "scroll", () => this.onScroll());
		this.registerRowEvents();

		// An inactive tab is display:none, so a render while it is hidden can only
		// guess row heights. Observing the viewport catches the moment it is shown
		// again (0 → real size), however Obsidian brings it back. The relayout runs
		// on the next frame: rendering inside the callback can resize the viewport
		// again and trip the "ResizeObserver loop" error.
		const resizeObserver = new ResizeObserver(() => {
			if (this.relayoutRaf) return;
			this.relayoutRaf = requestAnimationFrame(() => {
				this.relayoutRaf = 0;
				this.relayout();
			});
		});
		resizeObserver.observe(this.viewportEl);
		this.register(() => resizeObserver.disconnect());

		this.render();
		window.setTimeout(() => {
			this.contentEl.focus();
			this.relayout(); // viewport now has a real size; narrow state may flip
		}, 0);
		end();
	}

	async onClose(): Promise<void> {
		this.longPress.cancel();
		if (this.relayoutRaf) cancelAnimationFrame(this.relayoutRaf);
		this.contentEl.empty();
	}

	onResize(): void {
		this.relayout();
	}

	/**
	 * React to a size change. Hidden (zero width): nothing to do until shown.
	 * Crossing the narrow breakpoint changes the uniform row height, and a stale
	 * measurement (taken while hidden) was never right — both need a full
	 * re-layout. A width change (including being shown again) repaints every
	 * row; a height-only change (the detail strip grew) just widens the window.
	 */
	private relayout(): void {
		const width = this.viewportEl.clientWidth;
		if (width === 0) {
			this.lastWidth = 0;
			return;
		}
		const widthChanged = width !== this.lastWidth;
		this.lastWidth = width;
		const wasNarrow = this.contentEl.hasClass("is-narrow");
		this.updateNarrow();
		if (this.measureStale || this.contentEl.hasClass("is-narrow") !== wasNarrow) {
			this.render();
			return;
		}
		if (widthChanged) this.syncListGeometry();
		this.renderWindow(widthChanged);
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
		this.sections = [];
		let top = 0;
		for (const section of sections) {
			this.items.push({ top, height: this.sectionH, section: section.label });
			this.sections.push({ top, label: section.label });
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
		const probed = { rowH: row.offsetHeight, sectionH: section.offsetHeight };
		probe.remove();

		const m = resolveMeasurement(probed, this.trustedMeasurement);
		this.rowH = m.rowH;
		this.sectionH = m.sectionH;
		this.measureStale = m.stale;
		if (!m.stale) {
			this.trustedMeasurement = { rowH: m.rowH, sectionH: m.sectionH };
			this.syncListGeometry();
		}
		console.debug("taskbuffer: measure", {
			probed,
			rowH: this.rowH,
			sectionH: this.sectionH,
			stale: m.stale,
			width: this.viewportEl.clientWidth,
			narrow: this.contentEl.hasClass("is-narrow"),
		});
	}

	/**
	 * Read the sizer's place inside the scroller: its top offset (the viewport's
	 * padding) maps scrollTop to list coordinates, and its left/width line the
	 * pinned header up with the rows while leaving the scrollbar uncovered.
	 * Only meaningful while visible — a hidden view reads all zeros.
	 */
	private syncListGeometry(): void {
		this.sizerTop = this.sizerEl.offsetTop;
		this.stickyEl.style.left = `${this.sizerEl.offsetLeft}px`;
		this.stickyEl.style.width = `${this.sizerEl.clientWidth}px`;
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

	/** Render only the items inside the viewport (+overscan). Cheap; called every frame. */
	private renderWindow(force: boolean): void {
		if (this.rows.length === 0) {
			this.sizerEl.empty();
			this.stickyEl.hide();
			this.renderedStart = this.renderedEnd = -1;
			return;
		}
		const y = this.listY();
		const vh = this.viewportEl.clientHeight || 600;
		const overscan = OVERSCAN_ROWS * this.rowH;
		const start = firstVisibleItem(this.items, y - overscan);
		const bottom = y + vh + overscan;
		let end = start;
		while (end < this.items.length && (this.items[end] as VItem).top < bottom) end += 1;

		this.updateSticky(y);
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

	/** Scroll offset in list coordinates (the sizer sits below the viewport's padding). */
	private listY(): number {
		return this.viewportEl.scrollTop - this.sizerTop;
	}

	/** Pin the header of the section under the top edge; the next header pushes it up. */
	private updateSticky(y: number): void {
		const pinned = stickyHeader(this.sections, y, this.sectionH);
		if (!pinned) {
			this.stickyEl.hide();
			return;
		}
		if (this.stickyEl.textContent !== pinned.label) this.stickyEl.setText(pinned.label);
		this.stickyEl.style.height = `${this.sectionH}px`;
		this.stickyEl.style.transform = pinned.offset === 0 ? "" : `translateY(${pinned.offset}px)`;
		this.stickyEl.show();
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
		const task = row.task;
		checkbox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.runTask(task, (t) => this.host.engine.complete(t));
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
	}

	// ── row gestures (delegated: rows are rebuilt on every window paint) ─────────

	private registerRowEvents(): void {
		this.registerDomEvent(this.sizerEl, "click", (evt) => {
			const index = this.rowIndexAt(evt.target);
			if (index !== null) this.select(index);
		});
		this.registerDomEvent(this.sizerEl, "dblclick", (evt) => {
			const task = this.taskAt(this.rowIndexAt(evt.target));
			if (task) void this.host.openTaskSource(task);
		});
		// Right-click on desktop; Android also raises this for a long press, which
		// the touch tracker has already handled.
		this.registerDomEvent(this.sizerEl, "contextmenu", (evt) => {
			const index = this.rowIndexAt(evt.target);
			if (index === null) return;
			evt.preventDefault();
			if (Date.now() - this.lastLongPressAt < LONG_PRESS_CONTEXTMENU_GRACE_MS) return;
			this.select(index);
			this.openRowMenu(index, evt.clientX, evt.clientY);
		});
		this.registerDomEvent(this.sizerEl, "touchstart", (evt) => this.onTouchStart(evt), { passive: true });
	}

	/**
	 * Begin tracking a possible long press. Follow-up touch events always target
	 * the element the touch started on — even after a repaint detaches it — so
	 * listen on that element, not on the sizer the events could no longer reach.
	 */
	private onTouchStart(evt: TouchEvent): void {
		this.endPress();
		const touch = evt.touches[0];
		const index = this.rowIndexAt(evt.target);
		const target = evt.target as HTMLElement | null;
		if (evt.touches.length !== 1 || !touch || index === null || !target || target.closest("input")) return;
		this.pressIndex = index;
		this.pressEl = target.closest<HTMLElement>(".taskbuffer-row");
		this.pressEl?.addClass("is-pressing");

		const listeners = new AbortController();
		const finish = (): void => {
			this.endPress();
			listeners.abort();
		};
		target.addEventListener(
			"touchmove",
			(e: TouchEvent) => {
				const t = e.touches[0];
				if (e.touches.length !== 1 || !t) this.longPress.cancel();
				else this.longPress.move(t.clientX, t.clientY);
				if (!this.longPress.pending) this.pressEl?.removeClass("is-pressing");
			},
			{ signal: listeners.signal, passive: true },
		);
		target.addEventListener(
			"touchend",
			(e: TouchEvent) => {
				// Swallow the click (and the dblclick half) the lift would synthesize:
				// it would land outside the just-opened menu and close it.
				if (this.longPress.end()) e.preventDefault();
				finish();
			},
			{ signal: listeners.signal, passive: false },
		);
		target.addEventListener("touchcancel", finish, { signal: listeners.signal });
		this.longPress.start(touch.clientX, touch.clientY);
	}

	private endPress(): void {
		this.longPress.cancel();
		this.pressEl?.removeClass("is-pressing");
		this.pressEl = null;
	}

	private onLongPress(x: number, y: number): void {
		const index = this.pressIndex;
		this.pressEl?.removeClass("is-pressing");
		if (index === null || !this.rows[index]) return;
		this.lastLongPressAt = Date.now();
		haptic(LONG_PRESS_HAPTIC_MS);
		this.select(index);
		this.openRowMenu(index, x, y);
	}

	private rowIndexAt(target: EventTarget | null): number | null {
		const rowEl = (target as HTMLElement | null)?.closest?.<HTMLElement>(".taskbuffer-row");
		if (!rowEl) return null;
		const index = Number(rowEl.dataset.index);
		return Number.isInteger(index) && index >= 0 && index < this.rows.length ? index : null;
	}

	// ── task actions ─────────────────────────────────────────────────────────

	/** Long-press / right-click action sheet. On phones Obsidian shows it as a bottom sheet. */
	private openRowMenu(index: number, x: number, y: number): void {
		const task = this.taskAt(index);
		if (!task) return;
		const engine = this.host.engine;
		const today = todayEpoch();
		const menu = new Menu();
		const add = (section: string, title: string, icon: string, run: () => void): void => {
			menu.addItem((item) => item.setSection(section).setTitle(title).setIcon(icon).onClick(run));
		};
		add("status", "Complete", "check-circle", () => void this.runTask(task, (t) => engine.complete(t)));
		add("status", "Mark irrelevant", "circle-slash", () => void this.runTask(task, (t) => engine.markIrrelevant(t)));
		add("date", "Defer to date…", "calendar-clock", () => this.pickDeferDate(task, x, y));
		add("date", "Due today", "calendar-check", () => void this.runTask(task, (t) => engine.setDate(t, today)));
		add("date", "Due tomorrow", "calendar-plus", () => void this.runTask(task, (t) => engine.setDate(t, addDays(today, 1))));
		add("date", "Due in a week", "calendar-range", () => void this.runTask(task, (t) => engine.setDate(t, addDays(today, 7))));
		add("timer", "Start timer", "play", () => void this.runTask(task, (t) => engine.startTimer(t)));
		add("open", "Open note", "file-text", () => void this.host.openTaskSource(task));
		menu.showAtPosition({ x, y }, this.contentEl.doc);
	}

	/** Open the native date picker programmatically (desktop, keyboard, menu). */
	private pickDeferDate(task: Task, x: number, y: number): void {
		const initial = task.dueDate ?? todayEpoch();
		const defer = (epoch: number): void => void this.runTask(task, (t) => this.host.engine.deferTo(t, epoch));
		openDatePicker(this.contentEl.doc, x, y, initial, defer, () => new DeferDateModal(this.app, initial, defer).open());
	}

	/** Touch-sized buttons under the selected task's detail. */
	private renderActionBar(task: Task): void {
		const engine = this.host.engine;
		const today = todayEpoch();
		const bar = this.detailEl.createDiv({ cls: "taskbuffer-actions" });

		if (Platform.isMobile) {
			// A tap straight on a date input is the only reliable way to raise
			// the native picker on iOS; showPicker() there is best-effort. The
			// control is a <label>, not a <button>: an input inside a button is
			// invalid and some engines hand the tap to the button instead.
			const deferEl = this.actionButton(bar, "calendar-clock", "Defer", "Defer to a date", "label");
			attachDateOverlay(deferEl, task.dueDate ?? today, (epoch) => void this.runTask(task, (t) => engine.deferTo(t, epoch)));
		} else {
			const deferBtn = this.actionButton(bar, "calendar-clock", "Defer", "Defer to a date");
			deferBtn.addEventListener("click", () => {
				const rect = deferBtn.getBoundingClientRect();
				this.pickDeferDate(task, rect.left, rect.bottom);
			});
		}
		const buttons: Array<[string, string, string, () => void]> = [
			["calendar-check", "Today", "Due today", () => void this.runTask(task, (t) => engine.setDate(t, today))],
			["calendar-plus", "Tomorrow", "Due tomorrow", () => void this.runTask(task, (t) => engine.setDate(t, addDays(today, 1)))],
			["circle-slash", "Irrelevant", "Mark irrelevant", () => void this.runTask(task, (t) => engine.markIrrelevant(t))],
			["file-text", "Open", "Open note", () => void this.host.openTaskSource(task)],
		];
		for (const [icon, label, ariaLabel, run] of buttons) {
			this.actionButton(bar, icon, label, ariaLabel).addEventListener("click", run);
		}
	}

	private actionButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		ariaLabel: string,
		tag: "button" | "label" = "button",
	): HTMLElement {
		const attr: Record<string, string> = { "aria-label": ariaLabel };
		if (tag === "button") attr.type = "button";
		const btn = parent.createEl(tag, { cls: "taskbuffer-action", attr });
		setIcon(btn.createSpan({ cls: "taskbuffer-action-icon" }), icon);
		btn.createSpan({ cls: "taskbuffer-action-label", text: label });
		return btn;
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
		this.contentEl.toggleClass("is-detail-hidden", !this.showDetail);
		if (!this.showDetail) return;
		const row = this.rows[this.selected];
		if (!row) {
			this.detailEl.createSpan({ cls: "taskbuffer-detail-empty", text: "—" });
			return;
		}

		const info = this.detailEl.createDiv({ cls: "taskbuffer-detail-info" });
		const detailBodyEl = info.createDiv({ cls: "taskbuffer-detail-body" });
		this.renderBody(detailBodyEl, row.body, row.task.filePath);

		const meta = info.createDiv({ cls: "taskbuffer-detail-meta" });
		if (row.dateText) meta.createSpan({ cls: "taskbuffer-date", text: row.dateText });
		if (row.timeText) meta.createSpan({ cls: "taskbuffer-time", text: row.timeText });
		if (row.durationText) meta.createSpan({ cls: "taskbuffer-duration", text: row.durationText });
		for (const tag of row.tags) {
			meta.createSpan({ cls: "taskbuffer-tag", text: this.settings.formats.tagPrefix + tag });
		}

		const log = describeMarkers(row.markers);
		if (log.length > 0) {
			const logEl = info.createDiv({ cls: "taskbuffer-log" });
			for (const entry of log) {
				const item = logEl.createSpan({ cls: "taskbuffer-log-entry" });
				item.dataset.kind = entry.kind;
				item.createSpan({ cls: "taskbuffer-log-glyph", text: entry.glyph });
				item.createSpan({ cls: "taskbuffer-log-label", text: entry.label });
				if (entry.when) item.createSpan({ cls: "taskbuffer-log-when", text: entry.when });
			}
		}

		this.renderActionBar(row.task);
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

	/**
	 * Move selection to a specific row, scroll it into view, repaint window +
	 * detail. Rows already on screen are restyled in place rather than rebuilt,
	 * so a tap's second half (double tap) and a held touch keep their element.
	 */
	private select(index: number): void {
		if (this.rows.length === 0) return;
		this.selected = Math.max(0, Math.min(this.rows.length - 1, index));
		this.scrollSelectedIntoView();
		this.renderWindow(false);
		for (const el of Array.from(this.sizerEl.children) as HTMLElement[]) {
			if (el.dataset.index !== undefined) el.toggleClass("is-selected", el.dataset.index === String(this.selected));
		}
		this.updateDetail();
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
	}

	private scrollSelectedIntoView(): void {
		const rowTop = this.rowTop[this.selected];
		if (rowTop === undefined) return;
		const top = rowTop + this.sizerTop; // scroll-content coordinates
		const vh = this.viewportEl.clientHeight || 600;
		const scrollTop = this.viewportEl.scrollTop;
		// Keep the row clear of the pinned section header.
		const pinned = this.sections.length > 0 ? this.sectionH : 0;
		if (top - pinned < scrollTop) this.viewportEl.scrollTop = Math.max(0, top - pinned);
		else if (top + this.rowH > scrollTop + vh) this.viewportEl.scrollTop = top + this.rowH - vh;
	}

	// ── action dispatch ──────────────────────────────────────────────────────

	private taskAt(index: number | null): Task | null {
		return index === null ? null : (this.rows[index]?.task ?? null);
	}

	private async runOn(index: number, fn: (task: Task) => Promise<void> | void): Promise<void> {
		const task = this.taskAt(index);
		if (task) await this.runTask(task, fn);
	}

	/**
	 * Run a verb on a task captured when its button/menu was built — by the time
	 * the user taps, a re-render may have shifted which task sits at an index.
	 */
	private async runTask(task: Task, fn: (task: Task) => Promise<void> | void): Promise<void> {
		await fn(task);
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
			case "D": {
				if (!task) break;
				const rowEl = this.sizerEl.querySelector<HTMLElement>(`.taskbuffer-row[data-index="${this.selected}"]`);
				const rect = (rowEl ?? this.viewportEl).getBoundingClientRect();
				this.pickDeferDate(task, rect.left + rect.width / 2, rect.bottom);
				break;
			}
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
