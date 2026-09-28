// modals.ts — small dialogs: quick-create a task, and the OR tag filter picker.
import { App, Modal, Setting } from "obsidian";
import { addDays, epochToIsoDate, isoDateToEpoch, todayEpoch } from "./dates";

/** Prompt for a task body and hand it back. */
export class CreateTaskModal extends Modal {
	private value = "";
	private onSubmit: (body: string) => void;

	constructor(app: App, onSubmit: (body: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.setTitle("New task");
		const { contentEl } = this;
		new Setting(contentEl).setName("Task").addText((text) => {
			text.setPlaceholder("Buy groceries <30m> #errand (@[[2026-06-25]])");
			text.onChange((v) => (this.value = v));
			text.inputEl.addClass("taskbuffer-create-input");
			// Submit on Enter.
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Add")
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	private submit(): void {
		const body = this.value.trim();
		if (body === "") return;
		this.close();
		this.onSubmit(body);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Fallback date picker for defer-to-date, used only where the platform refuses
 * to open its native picker programmatically. The date field is still a native
 * `<input type="date">`, so tapping it raises the OS calendar.
 */
export class DeferDateModal extends Modal {
	private epoch: number;
	private onPick: (epoch: number) => void;

	constructor(app: App, initialEpoch: number, onPick: (epoch: number) => void) {
		super(app);
		this.epoch = initialEpoch;
		this.onPick = onPick;
	}

	onOpen(): void {
		this.setTitle("Defer to date");
		const { contentEl } = this;
		new Setting(contentEl).setName("Date").addText((text) => {
			text.inputEl.type = "date";
			text.setValue(epochToIsoDate(this.epoch));
			text.onChange((v) => {
				const epoch = isoDateToEpoch(v);
				if (epoch !== null) this.epoch = epoch;
			});
		});
		const quick = new Setting(contentEl);
		for (const [label, days] of [["Tomorrow", 1], ["Next week", 7]] as const) {
			quick.addButton((btn) => btn.setButtonText(label).onClick(() => this.submit(addDays(todayEpoch(), days))));
		}
		quick.addButton((btn) =>
			btn
				.setButtonText("Defer")
				.setCta()
				.onClick(() => this.submit(this.epoch)),
		);
	}

	private submit(epoch: number): void {
		this.close();
		this.onPick(epoch);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Toggle-list picker for the OR tag filter. */
export class TagFilterModal extends Modal {
	private tags: string[];
	private selected: Set<string>;
	private onApply: (tags: string[]) => void;

	constructor(app: App, tags: string[], current: string[], onApply: (tags: string[]) => void) {
		super(app);
		this.tags = tags;
		this.selected = new Set(current);
		this.onApply = onApply;
	}

	onOpen(): void {
		this.setTitle("Filter by tag");
		const { contentEl } = this;
		if (this.tags.length === 0) {
			contentEl.createEl("p", { text: "No tags found in the current tasks." });
		}
		for (const tag of this.tags) {
			new Setting(contentEl).setName(tag).addToggle((toggle) => {
				toggle.setValue(this.selected.has(tag));
				toggle.onChange((on) => {
					if (on) this.selected.add(tag);
					else this.selected.delete(tag);
				});
			});
		}
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Apply")
					.setCta()
					.onClick(() => {
						this.close();
						this.onApply([...this.selected]);
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Clear").onClick(() => {
					this.close();
					this.onApply([]);
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
