import { App, PluginSettingTab, Setting } from "obsidian";
import type TaskbufferPlugin from "./main";
import { DEFAULT_HORIZONS, HorizonSpec, OverlapMode, WeekStart } from "./config";

const WEEK_STARTS: WeekStart[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const OVERLAP_MODES: OverlapMode[] = ["sorted", "first_match", "narrowest"];

/** Serialize horizons as `Label | after` lines (after = number / duration / keyword / "undated"). */
function serializeHorizons(specs: HorizonSpec[] | null): string {
	return (specs ?? DEFAULT_HORIZONS)
		.map((s) => `${s.label} | ${s.undated ? "undated" : String(s.after)}`)
		.join("\n");
}

function parseHorizons(text: string): HorizonSpec[] {
	const out: HorizonSpec[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const bar = line.indexOf("|");
		const label = (bar === -1 ? line : line.slice(0, bar)).trim();
		const after = (bar === -1 ? "" : line.slice(bar + 1)).trim();
		if (label === "") continue;
		if (after === "undated") out.push({ label, undated: true });
		else if (/^-?\d+$/.test(after)) out.push({ label, after: Number.parseInt(after, 10) });
		else out.push({ label, after });
	}
	return out;
}

function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

export class TaskbufferSettingTab extends PluginSettingTab {
	private plugin: TaskbufferPlugin;

	constructor(app: App, plugin: TaskbufferPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		void this.plugin.refreshAndRender();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const persist = () => void this.plugin.persistSettings();
		const save = () => void this.plugin.saveSettings();

		// ── Sources ──────────────────────────────────────────────────────────
		new Setting(containerEl).setName("Sources").setHeading();

		new Setting(containerEl)
			.setName("Source folders")
			.setDesc("Vault-relative folders to scan, one per line. Leave empty to scan the whole vault.")
			.addTextArea((ta) => {
				ta.setPlaceholder("Notes/projects");
				ta.setValue(s.sources.join("\n"));
				ta.onChange((v) => {
					s.sources = v.split("\n").map((x) => x.trim()).filter((x) => x !== "");
					persist();
				});
			});

		new Setting(containerEl)
			.setName("Inbox file")
			.setDesc("Destination for newly created tasks. A vault-relative path.")
			.addText((t) =>
				t.setValue(s.inbox.file).onChange((v) => {
					s.inbox.file = v.trim() || "inbox.md";
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Inbox header")
			.setDesc("Optional header to insert new tasks beneath (leave empty to append).")
			.addText((t) =>
				t.setValue(s.inbox.header ?? "").onChange((v) => {
					s.inbox.header = v.trim() === "" ? null : v;
					persist();
				}),
			);

		// ── Display ──────────────────────────────────────────────────────────
		new Setting(containerEl).setName("Display").setHeading();

		new Setting(containerEl)
			.setName("Show undated tasks")
			.setDesc("Show the undated section by default.")
			.addToggle((t) =>
				t.setValue(s.showUndated).onChange((v) => {
					s.showUndated = v;
					save();
				}),
			);

		new Setting(containerEl)
			.setName("Strict date validation")
			.setDesc("Report invalid dates instead of silently skipping them.")
			.addToggle((t) =>
				t.setValue(s.strict).onChange((v) => {
					s.strict = v;
					save();
				}),
			);

		new Setting(containerEl)
			.setName("Week starts on")
			.setDesc("Affects the end-of-week horizon.")
			.addDropdown((d) => {
				for (const w of WEEK_STARTS) d.addOption(w, w[0]!.toUpperCase() + w.slice(1));
				d.setValue(s.weekStart).onChange((v) => {
					s.weekStart = v as WeekStart;
					save();
				});
			});

		new Setting(containerEl)
			.setName("Horizon overlap")
			.setDesc("How a date is assigned when horizons overlap.")
			.addDropdown((d) => {
				for (const m of OVERLAP_MODES) d.addOption(m, m);
				d.setValue(s.horizonsOverlap).onChange((v) => {
					s.horizonsOverlap = v as OverlapMode;
					save();
				});
			});

		new Setting(containerEl)
			.setName("Horizons")
			.setDesc('One per line, written as "name | after". The after value is a day offset (0), a duration (31d, 1w), a keyword (past, end_of_week, end_of_month, end_of_quarter, end_of_year, yesterday), or "undated".')
			.addTextArea((ta) => {
				ta.setValue(serializeHorizons(s.horizons));
				ta.inputEl.rows = 9;
				ta.onChange((v) => {
					const parsed = parseHorizons(v);
					s.horizons = parsed.length === 0 || serializeHorizons(parsed) === serializeHorizons(null) ? null : parsed;
					persist();
				});
			});

		// ── Task format ────────────────────────────────────────────────────────
		new Setting(containerEl).setName("Task format").setHeading();

		new Setting(containerEl)
			.setName("Date format")
			.setDesc("Strftime date pattern, e.g. %Y-%m-%d, %m/%d/%Y, %d.%m.%Y.")
			.addText((t) =>
				t.setValue(s.formats.date).onChange((v) => {
					s.formats.date = v.trim() || "%Y-%m-%d";
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Time format")
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- contains literal strftime codes
			.setDesc("Strftime time pattern, e.g. %H:%M or %I:%M %p.")
			.addText((t) =>
				t.setValue(s.formats.time).onChange((v) => {
					s.formats.time = v.trim() || "%H:%M";
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Tag prefix")
			.addText((t) =>
				t.setValue(s.formats.tagPrefix).onChange((v) => {
					s.formats.tagPrefix = v || "#";
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Date wrapper")
			.setDesc('Comma-separated. 3 parts [open, mid, close] put the time between mid and close; 2 parts [open, close] put it before close.')
			.addText((t) =>
				t.setValue(s.formats.dateWrapper.join(",")).onChange((v) => {
					s.formats.dateWrapper = v.split(",");
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Marker prefix")
			.setDesc("Prefix for state markers (start, stop, complete, …).")
			.addText((t) =>
				t.setValue(s.formats.markerPrefix).onChange((v) => {
					s.formats.markerPrefix = v || "::";
					persist();
				}),
			);

		new Setting(containerEl).setName("Open checkbox").addText((t) =>
			t.setValue(s.formats.checkbox.open).onChange((v) => {
				s.formats.checkbox.open = v;
				persist();
			}),
		);
		new Setting(containerEl).setName("Done checkbox").addText((t) =>
			t.setValue(s.formats.checkbox.done).onChange((v) => {
				s.formats.checkbox.done = v;
				persist();
			}),
		);
		new Setting(containerEl).setName("Irrelevant checkbox").addText((t) =>
			t.setValue(s.formats.checkbox.irrelevant).onChange((v) => {
				s.formats.checkbox.irrelevant = v;
				persist();
			}),
		);

		// ── Frontmatter ────────────────────────────────────────────────────────
		new Setting(containerEl).setName("Frontmatter").setHeading();

		new Setting(containerEl)
			.setName("Due property")
			.setDesc("Frontmatter key an undated task inherits its due date from.")
			.addText((t) =>
				t.setValue(s.frontmatter.dueKey).onChange((v) => {
					s.frontmatter.dueKey = v.trim() || "due";
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Inherit due from frontmatter")
			.addToggle((t) =>
				t.setValue(s.frontmatter.inheritDue).onChange((v) => {
					s.frontmatter.inheritDue = v;
					save();
				}),
			);

		new Setting(containerEl)
			.setName("Require tags for inheritance")
			.setDesc("Comma-separated. Only inherit a file's due if its frontmatter tags include all of these.")
			.addText((t) =>
				t.setValue(s.frontmatter.requireTags.join(",")).onChange((v) => {
					s.frontmatter.requireTags = splitCsv(v);
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Status property")
			.addText((t) =>
				t.setValue(s.frontmatter.status.key).onChange((v) => {
					s.frontmatter.status.key = v.trim() || "status";
					persist();
				}),
			);

		new Setting(containerEl)
			.setName("Done status values")
			.setDesc("Comma-separated. A file with a due and one of these statuses hides its undated tasks.")
			.addText((t) =>
				t.setValue(s.frontmatter.status.doneValues.join(",")).onChange((v) => {
					s.frontmatter.status.doneValues = splitCsv(v);
					persist();
				}),
			);
	}
}
