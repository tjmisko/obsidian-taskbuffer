import { describe, it, expect } from "vitest";
import { buildSections, collectTags, RenderOptions } from "../src/render/rows";
import { mergeSettings } from "../src/config";
import { ymdToEpoch } from "../src/dates";
import { Task, TaskStatus } from "../src/types";

const settings = mergeSettings({});
const TODAY = ymdToEpoch(2026, 6, 23); // Tuesday

let seq = 0;
function task(partial: Partial<Task> & { dueDate: number | null }): Task {
	return {
		filePath: partial.filePath ?? `f${seq++}.md`,
		lineNumber: partial.lineNumber ?? 1,
		body: partial.body ?? "Task",
		dueDate: partial.dueDate,
		dueTime: partial.dueTime ?? "",
		duration: partial.duration ?? "",
		tags: partial.tags ?? [],
		status: (partial.status ?? "open") as TaskStatus,
		markers: partial.markers ?? [],
		sortLast: partial.sortLast ?? false,
	};
}

const opts = (over: Partial<RenderOptions> = {}): RenderOptions => ({
	today: TODAY,
	showUndated: true,
	showMarkers: false,
	tagFilter: [],
	...over,
});

describe("buildSections", () => {
	it("buckets tasks into default horizons in display order", () => {
		const tasks = [
			task({ dueDate: ymdToEpoch(2026, 6, 18), body: "overdue" }),
			task({ dueDate: TODAY, body: "today" }),
			task({ dueDate: ymdToEpoch(2026, 6, 24), body: "tomorrow" }),
			task({ dueDate: ymdToEpoch(2026, 6, 25), body: "thisweek" }),
			task({ dueDate: null, body: "someday" }),
		];
		const sections = buildSections(tasks, settings, opts());
		expect(sections.map((s) => s.label)).toEqual(["Overdue", "Today", "Tomorrow", "This Week", "Someday"]);
		expect(sections[0]!.rows[0]!.body).toBe("overdue");
	});

	it("excludes done and irrelevant tasks", () => {
		const tasks = [
			task({ dueDate: TODAY, body: "open", status: "open" }),
			task({ dueDate: TODAY, body: "done", status: "done" }),
			task({ dueDate: TODAY, body: "skip", status: "irrelevant" }),
		];
		const sections = buildSections(tasks, settings, opts());
		expect(sections).toHaveLength(1);
		expect(sections[0]!.rows.map((r) => r.body)).toEqual(["open"]);
	});

	it("hides the undated section when showUndated is false", () => {
		const tasks = [task({ dueDate: null, body: "someday" })];
		expect(buildSections(tasks, settings, opts({ showUndated: false }))).toHaveLength(0);
		expect(buildSections(tasks, settings, opts({ showUndated: true }))).toHaveLength(1);
	});

	it("applies an OR tag filter", () => {
		const tasks = [
			task({ dueDate: TODAY, body: "a", tags: ["work"], filePath: "a.md" }),
			task({ dueDate: TODAY, body: "b", tags: ["home"], filePath: "b.md" }),
			task({ dueDate: TODAY, body: "c", tags: ["work", "urgent"], filePath: "c.md" }),
		];
		const sections = buildSections(tasks, settings, opts({ tagFilter: ["work"] }));
		expect(sections[0]!.rows.map((r) => r.body)).toEqual(["a", "c"]);
	});

	it("sorts within a bucket by date, path, real-before-synthetic, line", () => {
		const tasks = [
			task({ dueDate: ymdToEpoch(2026, 6, 18), filePath: "b.md", lineNumber: 2, body: "second" }),
			task({ dueDate: ymdToEpoch(2026, 6, 18), filePath: "a.md", lineNumber: 9, body: "first" }),
			task({ dueDate: ymdToEpoch(2026, 6, 18), filePath: "a.md", lineNumber: 1, sortLast: true, body: "project" }),
		];
		const overdue = buildSections(tasks, settings, opts())[0]!;
		// a.md real (line 9) before a.md synthetic (sortLast), then b.md.
		expect(overdue.rows.map((r) => r.body)).toEqual(["first", "project", "second"]);
	});

	it("formats the date column via the configured format", () => {
		const us = mergeSettings({ formats: { date: "%m/%d/%Y" } });
		const sections = buildSections([task({ dueDate: ymdToEpoch(2026, 6, 23) })], us, opts());
		expect(sections[0]!.rows[0]!.dateText).toBe("06/23/2026");
	});

	it("collectTags returns distinct tags in first-seen order", () => {
		const tasks = [task({ dueDate: null, tags: ["a", "b"] }), task({ dueDate: null, tags: ["b", "c"] })];
		expect(collectTags(tasks)).toEqual(["a", "b", "c"]);
	});
});
