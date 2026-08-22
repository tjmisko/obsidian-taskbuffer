import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/config";
import { ymdToEpoch } from "../src/dates";
import { fileEntryFromSnapshot, type FileContentSnapshot } from "../src/file-entry";
import { buildParseContext } from "../src/parse/parse";

function snapshot(overrides: Partial<FileContentSnapshot> = {}): FileContentSnapshot {
	return {
		path: "Projects/Launch plan.md",
		basename: "Launch plan",
		mtime: 123_456,
		size: 789,
		content: "",
		frontmatter: null,
		...overrides,
	};
}

describe("fileEntryFromSnapshot", () => {
	it("parses event content and preserves all task forms and source metadata", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		const input = snapshot({
			content: [
				"- [ ] Open task",
				"- [x] Done task (@[[2026-08-20]]) ::complete [[2026-08-20]] 09:15",
				"- [-] Irrelevant task",
				"- [ ] Dated and tagged #inline (@[[2026-08-21]]) ::start [[2026-08-21]] 10:00",
			].join("\n"),
		});
		const entry = fileEntryFromSnapshot(input, buildParseContext(settings, false), settings);

		expect(entry.path).toBe("Projects/Launch plan.md");
		expect(entry.mtime).toBe(123_456);
		expect(entry.size).toBe(789);
		expect(entry.errors).toEqual([]);
		expect(entry.enriched.map((task) => task.status)).toEqual(["open", "done", "irrelevant", "open"]);
		expect(entry.enriched[1]!.markers).toEqual([
			{ kind: "complete", date: "2026-08-20", time: "09:15" },
		]);
		expect(entry.enriched[3]!.tags).toEqual(["inline"]);
		expect(entry.enriched[3]!.dueDate).toBe(ymdToEpoch(2026, 8, 21));
		expect(entry.enriched[3]!.markers[0]!.kind).toBe("start");
		expect(entry.enriched.every((task) => task.filePath === input.path)).toBe(true);
	});

	it("inherits supplied frontmatter tags and due and appends a synthetic project task", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		const input = snapshot({
			content: "- [ ] Prepare slides #inline",
			frontmatter: { tags: ["project", "work"], due: "2026-09-02 14:30", status: "active" },
		});
		const entry = fileEntryFromSnapshot(input, buildParseContext(settings, false), settings);

		expect(entry.enriched).toHaveLength(2);
		expect(entry.enriched[0]).toMatchObject({
			body: "Prepare slides",
			filePath: input.path,
			dueDate: ymdToEpoch(2026, 9, 2),
			dueTime: "14:30",
			tags: ["inline", "project", "work"],
			sortLast: false,
		});
		expect(entry.enriched[1]).toMatchObject({
			body: "Launch plan",
			filePath: input.path,
			dueDate: ymdToEpoch(2026, 9, 2),
			dueTime: "14:30",
			tags: ["project", "work"],
			sortLast: true,
		});
	});

	it("isolates strict-mode errors to the file being parsed", () => {
		const settings = mergeSettings({ strict: true });
		const ctx = buildParseContext(settings, true);
		const first = fileEntryFromSnapshot(
			snapshot({ path: "first.md", basename: "first", content: "- [ ] Bad (@[[2026-02-30]])" }),
			ctx,
			settings,
		);
		const second = fileEntryFromSnapshot(
			snapshot({ path: "second.md", basename: "second", content: "- [ ] Worse (@[[2026-13-01]])" }),
			ctx,
			settings,
		);

		expect(first.errors).toHaveLength(1);
		expect(first.errors[0]!.filePath).toBe("first.md");
		expect(second.errors).toHaveLength(1);
		expect(second.errors[0]!.filePath).toBe("second.md");
		expect(ctx.dateErrors).toHaveLength(2);
	});

	it("returns an empty entry for empty and non-task content", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		for (const content of ["", "# Heading\nPlain text\n"]) {
			const input = snapshot({ content });
			const entry = fileEntryFromSnapshot(input, buildParseContext(settings, false), settings);
			expect(entry).toMatchObject({ path: input.path, mtime: input.mtime, size: input.size });
			expect(entry.enriched).toEqual([]);
			expect(entry.errors).toEqual([]);
		}
	});
});
