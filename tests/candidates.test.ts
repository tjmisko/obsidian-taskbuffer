import { describe, it, expect } from "vitest";

import {
	selectCandidates,
	openCharsFromSettings,
	isProjectFile,
	type FileCandidateInfo,
} from "../src/candidates";
import { DEFAULT_SETTINGS, type TaskbufferSettings } from "../src/config";

function makeSettings(mutate: (s: TaskbufferSettings) => void = () => {}): TaskbufferSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	mutate(settings);
	return settings;
}

function info(overrides: Partial<FileCandidateInfo> & { path: string }): FileCandidateInfo {
	return {
		taskChars: [],
		frontmatter: null,
		cached: true,
		...overrides,
	};
}

// ── openCharsFromSettings ─────────────────────────────────────────────────────

describe("openCharsFromSettings", () => {
	it("should derive the open glyph from the default '- [ ]' checkbox", () => {
		expect(openCharsFromSettings(makeSettings())).toEqual([" "]);
	});

	it("should derive a custom open glyph", () => {
		const settings = makeSettings((s) => (s.formats.checkbox.open = "- [/]"));
		expect(openCharsFromSettings(settings)).toEqual(["/"]);
	});

	it("should return null when the open format has no parseable [x] slot", () => {
		const settings = makeSettings((s) => (s.formats.checkbox.open = "TODO:"));
		expect(openCharsFromSettings(settings)).toBeNull();
	});

	it("should return null (any-task fallback) for an empty bracket slot", () => {
		const settings = makeSettings((s) => (s.formats.checkbox.open = "- []"));
		expect(openCharsFromSettings(settings)).toBeNull();
	});
});

// ── isProjectFile ─────────────────────────────────────────────────────────────

describe("isProjectFile", () => {
	const settings = makeSettings();

	it("should accept a file tagged project with a due", () => {
		expect(isProjectFile({ tags: ["project"], due: "2026-05-01" }, settings)).toBe(true);
	});

	it("should reject a project-tagged file with no due", () => {
		expect(isProjectFile({ tags: ["project"] }, settings)).toBe(false);
	});

	it("should reject a due-bearing file not tagged project", () => {
		expect(isProjectFile({ tags: ["work"], due: "2026-05-01" }, settings)).toBe(false);
	});

	it("should ignore a scalar (non-list) tags value", () => {
		expect(isProjectFile({ tags: "project", due: "2026-05-01" }, settings)).toBe(false);
	});

	it("should reject when there is no frontmatter", () => {
		expect(isProjectFile(null, settings)).toBe(false);
	});
});

// ── selectCandidates ──────────────────────────────────────────────────────────

describe("selectCandidates", () => {
	const settings = makeSettings();
	const openChars = openCharsFromSettings(settings); // [" "]

	it("should include a file with an open task", () => {
		const infos = [info({ path: "open.md", taskChars: [" "] })];
		expect(selectCandidates(infos, openChars, settings)).toEqual(["open.md"]);
	});

	it("should exclude a done-only file (no open glyph)", () => {
		const infos = [info({ path: "done.md", taskChars: ["x"] })];
		expect(selectCandidates(infos, openChars, settings)).toEqual([]);
	});

	it("should exclude an irrelevant-only file", () => {
		const infos = [info({ path: "irrelevant.md", taskChars: ["-"] })];
		expect(selectCandidates(infos, openChars, settings)).toEqual([]);
	});

	it("should include a project-only file with no task lines", () => {
		const infos = [info({ path: "proj.md", taskChars: [], frontmatter: { tags: ["project"], due: "2026-05-01" } })];
		expect(selectCandidates(infos, openChars, settings)).toEqual(["proj.md"]);
	});

	it("should include an uncached file regardless of its metadata", () => {
		const infos = [info({ path: "fresh.md", taskChars: [], cached: false })];
		expect(selectCandidates(infos, openChars, settings)).toEqual(["fresh.md"]);
	});

	it("should exclude a plain cached file with neither open tasks nor project frontmatter", () => {
		const infos = [info({ path: "note.md", taskChars: [], frontmatter: { title: "x" } })];
		expect(selectCandidates(infos, openChars, settings)).toEqual([]);
	});

	it("should treat any task list item as a candidate when openChars is null (fallback)", () => {
		const infos = [
			info({ path: "done.md", taskChars: ["x"] }),
			info({ path: "open.md", taskChars: [" "] }),
			info({ path: "plain.md", taskChars: [] }),
		];
		expect(selectCandidates(infos, null, settings)).toEqual(["done.md", "open.md"]);
	});

	it("should match a custom open glyph", () => {
		const custom = makeSettings((s) => (s.formats.checkbox.open = "- [/]"));
		const infos = [
			info({ path: "slash.md", taskChars: ["/"] }),
			info({ path: "space.md", taskChars: [" "] }),
		];
		expect(selectCandidates(infos, openCharsFromSettings(custom), custom)).toEqual(["slash.md"]);
	});

	it("should preserve input order and select a realistic mix", () => {
		const infos = [
			info({ path: "a-open.md", taskChars: [" ", "x"] }), // mixed open+done → in
			info({ path: "b-done.md", taskChars: ["x"] }), // done-only → out
			info({ path: "c-proj.md", taskChars: [], frontmatter: { tags: ["project"], due: "2026-01-01" } }),
			info({ path: "d-empty.md", taskChars: [] }), // out
			info({ path: "e-fresh.md", cached: false }), // uncached → in
		];
		expect(selectCandidates(infos, openChars, settings)).toEqual(["a-open.md", "c-proj.md", "e-fresh.md"]);
	});
});
