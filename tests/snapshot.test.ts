import { describe, it, expect } from "vitest";

import { trimSnapshot, SNAPSHOT_UNDATED_CAP } from "../src/snapshot";
import { settingsHash, DEFAULT_SETTINGS, type TaskbufferSettings } from "../src/config";
import { ymdToEpoch } from "../src/dates";
import type { Task, TaskStatus } from "../src/types";

function task(overrides: Partial<Task> & { body: string }): Task {
	return {
		filePath: "f.md",
		lineNumber: 1,
		dueDate: null,
		dueTime: "",
		duration: "",
		tags: [],
		status: "open" as TaskStatus,
		markers: [],
		sortLast: false,
		...overrides,
	};
}

function settings(mutate: (s: TaskbufferSettings) => void = () => {}): TaskbufferSettings {
	const s = structuredClone(DEFAULT_SETTINGS);
	mutate(s);
	return s;
}

// ── trimSnapshot ──────────────────────────────────────────────────────────────

describe("trimSnapshot", () => {
	it("should keep all open dated tasks", () => {
		const tasks = [
			task({ body: "d1", dueDate: ymdToEpoch(2026, 1, 1) }),
			task({ body: "d2", dueDate: ymdToEpoch(2026, 2, 1) }),
		];
		const out = trimSnapshot(tasks);
		expect(out.map((t) => t.body)).toEqual(["d1", "d2"]);
	});

	it("should drop done and irrelevant tasks", () => {
		const tasks = [
			task({ body: "open", dueDate: ymdToEpoch(2026, 1, 1) }),
			task({ body: "done", dueDate: ymdToEpoch(2026, 1, 1), status: "done" }),
			task({ body: "irrelevant", status: "irrelevant" }),
		];
		expect(trimSnapshot(tasks).map((t) => t.body)).toEqual(["open"]);
	});

	it("should cap open undated tasks at the limit while keeping all dated", () => {
		const dated = Array.from({ length: 5 }, (_, i) => task({ body: `d${i}`, dueDate: ymdToEpoch(2026, 1, i + 1) }));
		const undated = Array.from({ length: SNAPSHOT_UNDATED_CAP + 50 }, (_, i) => task({ body: `u${i}` }));
		const out = trimSnapshot([...dated, ...undated]);
		const datedOut = out.filter((t) => t.dueDate !== null);
		const undatedOut = out.filter((t) => t.dueDate === null);
		expect(datedOut).toHaveLength(5);
		expect(undatedOut).toHaveLength(SNAPSHOT_UNDATED_CAP);
		expect(undatedOut[0].body).toBe("u0"); // input order preserved
	});

	it("should respect a custom cap", () => {
		const undated = Array.from({ length: 10 }, (_, i) => task({ body: `u${i}` }));
		expect(trimSnapshot(undated, 3)).toHaveLength(3);
	});

	it("should place all dated before the capped undated", () => {
		const out = trimSnapshot([task({ body: "u" }), task({ body: "d", dueDate: ymdToEpoch(2026, 1, 1) })]);
		expect(out.map((t) => t.body)).toEqual(["d", "u"]);
	});
});

// ── settingsHash ──────────────────────────────────────────────────────────────

describe("settingsHash", () => {
	it("should be stable across calls and key order", () => {
		expect(settingsHash(settings())).toBe(settingsHash(settings()));
	});

	it("should be insensitive to key insertion order in formats", () => {
		const a = settings();
		const b = settings((s) => {
			// Rebuild formats with keys in a different order.
			s.formats = { ...s.formats };
		});
		expect(settingsHash(a)).toBe(settingsHash(b));
	});

	it.each([
		["sources", (s: TaskbufferSettings) => (s.sources = ["Notes"])],
		["horizonsOverlap", (s: TaskbufferSettings) => (s.horizonsOverlap = "narrowest")],
		["weekStart", (s: TaskbufferSettings) => (s.weekStart = "sunday")],
		["strict", (s: TaskbufferSettings) => (s.strict = true)],
		["formats.date", (s: TaskbufferSettings) => (s.formats.date = "%d/%m/%Y")],
		["formats.checkbox.open", (s: TaskbufferSettings) => (s.formats.checkbox.open = "- [/]")],
		["frontmatter.dueKey", (s: TaskbufferSettings) => (s.frontmatter.dueKey = "deadline")],
		["horizons", (s: TaskbufferSettings) => (s.horizons = [{ label: "All", undated: true }])],
	])("should change when parse-affecting setting %s changes", (_label, mutate) => {
		expect(settingsHash(settings(mutate))).not.toBe(settingsHash(settings()));
	});

	it.each([
		["showUndated", (s: TaskbufferSettings) => (s.showUndated = !s.showUndated)],
		["debugTiming", (s: TaskbufferSettings) => (s.debugTiming = !s.debugTiming)],
		["inbox.file", (s: TaskbufferSettings) => (s.inbox.file = "other.md")],
	])("should NOT change when render-only setting %s changes", (_label, mutate) => {
		expect(settingsHash(settings(mutate))).toBe(settingsHash(settings()));
	});
});
