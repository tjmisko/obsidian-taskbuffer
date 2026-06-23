// modals.ts — small dialogs: quick-create a task, and the OR tag filter picker.
import { App, Modal, Setting } from "obsidian";

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
