import { describe, it, expect } from "vitest";

import {
	enrichTasks,
	enrichFileTasks,
	projectTaskFor,
	parseFrontmatterDue,
	type FileMeta,
} from "../src/frontmatter";
import { DEFAULT_SETTINGS, type TaskbufferSettings, type FrontmatterConfig } from "../src/config";
import { ymdToEpoch } from "../src/dates";
import type { Task, TaskStatus } from "../src/types";

// ── builders ──────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<FrontmatterConfig> = {}): TaskbufferSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.frontmatter = {
		...settings.frontmatter,
		...overrides,
		status: { ...settings.frontmatter.status, ...(overrides.status ?? {}) },
	};
	return settings;
}

function makeTask(
	filePath: string,
	body: string,
	opts: Partial<Pick<Task, "lineNumber" | "dueDate" | "dueTime" | "tags" | "status">> = {},
): Task {
	return {
		filePath,
		lineNumber: opts.lineNumber ?? 1,
		body,
		dueDate: opts.dueDate ?? null,
		dueTime: opts.dueTime ?? "",
		duration: "",
		tags: opts.tags ?? [],
		status: (opts.status ?? "open") as TaskStatus,
		markers: [],
		sortLast: false,
	};
}

function makeFile(
	path: string,
	frontmatter: Record<string, unknown> | null,
	basename = path.replace(/\.md$/, ""),
): FileMeta {
	return { path, basename, frontmatter };
}

/** Convenience: run enrichTasks for a single file. */
function enrichOne(
	file: FileMeta,
	tasks: Task[],
	settings: TaskbufferSettings = makeSettings(),
): Task[] {
	return enrichTasks(new Map([[file.path, tasks]]), [file], settings);
}

// ── 1. basic due inheritance ────────────────────────────────────────────────

describe("due inheritance", () => {
	it("should inherit the frontmatter due into undated tasks and leave inline-dated tasks alone", () => {
		const file = makeFile("basic-inherit.md", { due: "2026-04-15", tags: ["work"] });
		const inlineEpoch = ymdToEpoch(2026, 3, 1);
		const result = enrichOne(file, [
			makeTask("basic-inherit.md", "Undated task one"),
			makeTask("basic-inherit.md", "Undated task two"),
			makeTask("basic-inherit.md", "Dated inline", { dueDate: inlineEpoch }),
		]);

		expect(result).toHaveLength(3);
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 4, 15));
		expect(result[1].dueDate).toBe(ymdToEpoch(2026, 4, 15));
		expect(result[2].dueDate).toBe(inlineEpoch); // inline wins
		// frontmatter tags inherited by every task
		expect(result.map((t) => t.tags)).toEqual([["work"], ["work"], ["work"]]);
	});

	it("should not inherit when inheritDue is false", () => {
		const file = makeFile("basic-inherit.md", { due: "2026-04-15", tags: ["work"] });
		const result = enrichOne(file, [makeTask("basic-inherit.md", "Undated")], makeSettings({ inheritDue: false }));
		expect(result[0].dueDate).toBeNull();
		expect(result[0].tags).toEqual(["work"]); // tag inheritance still runs
	});

	it("should leave undated tasks undated when the file has no frontmatter due", () => {
		const file = makeFile("no-due.md", { tags: ["random"] });
		const result = enrichOne(file, [makeTask("no-due.md", "Undated")]);
		expect(result[0].dueDate).toBeNull();
	});

	it("should leave tasks untouched when there is no frontmatter at all", () => {
		const file = makeFile("no-frontmatter.md", null);
		const result = enrichOne(file, [makeTask("no-frontmatter.md", "Undated", { tags: ["x"] })]);
		expect(result[0].dueDate).toBeNull();
		expect(result[0].tags).toEqual(["x"]);
	});

	it("should ignore a calendar-invalid frontmatter due", () => {
		const file = makeFile("bad.md", { due: "2026-02-30" });
		const result = enrichOne(file, [makeTask("bad.md", "Undated")]);
		expect(result[0].dueDate).toBeNull();
	});
});

// ── 2. custom keys ───────────────────────────────────────────────────────────

describe("custom keys", () => {
	it("should inherit using a custom due key", () => {
		const file = makeFile("custom-key.md", { deadline: "2026-06-01", tags: ["work"] });
		const inlineEpoch = ymdToEpoch(2026, 7, 1);
		const result = enrichOne(
			file,
			[
				makeTask("custom-key.md", "Uses deadline"),
				makeTask("custom-key.md", "Inline overrides", { dueDate: inlineEpoch }),
			],
			makeSettings({ dueKey: "deadline" }),
		);
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 6, 1));
		expect(result[1].dueDate).toBe(inlineEpoch);
	});

	it("should drop undated tasks when a custom status key holds a done value", () => {
		const file = makeFile("custom-status.md", {
			deadline: "2026-06-15",
			state: "archived",
			tags: ["old"],
		});
		const inlineEpoch = ymdToEpoch(2026, 8, 1);
		const result = enrichOne(
			file,
			[
				makeTask("custom-status.md", "Undated archived"),
				makeTask("custom-status.md", "Another undated"),
				makeTask("custom-status.md", "Inline survives", { dueDate: inlineEpoch }),
			],
			makeSettings({ dueKey: "deadline", status: { key: "state", doneValues: ["archived"] } }),
		);
		expect(result).toHaveLength(1);
		expect(result[0].body).toBe("Inline survives");
		expect(result[0].dueDate).toBe(inlineEpoch);
	});
});

// ── 3. completion filtering ─────────────────────────────────────────────────

describe("completion filtering", () => {
	it("should drop undated tasks but keep inline-dated tasks in a done file", () => {
		const file = makeFile("done-mixed.md", { due: "2026-03-15", status: "done", tags: ["finished"] });
		const a = ymdToEpoch(2026, 6, 1);
		const b = ymdToEpoch(2026, 6, 15);
		const result = enrichOne(file, [
			makeTask("done-mixed.md", "Undated 1"),
			makeTask("done-mixed.md", "Undated 2"),
			makeTask("done-mixed.md", "Inline 1", { dueDate: a }),
			makeTask("done-mixed.md", "Inline 2", { dueDate: b }),
		]);
		expect(result.map((t) => t.body)).toEqual(["Inline 1", "Inline 2"]);
		// survivors keep their inline date and still inherit the file's tags
		expect(result[0].dueDate).toBe(a);
		expect(result[0].tags).toEqual(["finished"]);
	});

	it("should match done values case-insensitively", () => {
		const file = makeFile("done.md", { due: "2026-04-01", status: "DONE" });
		const result = enrichOne(file, [makeTask("done.md", "Undated leftover")]);
		expect(result).toHaveLength(0);
	});

	it("should keep undated tasks when the file is done but has no due", () => {
		const file = makeFile("statusonly.md", { status: "done", tags: ["x"] });
		const result = enrichOne(file, [makeTask("statusonly.md", "Undated")]);
		expect(result).toHaveLength(1);
		expect(result[0].dueDate).toBeNull(); // no due to inherit either
	});

	it("should keep undated tasks when an active-status file has a due (only done filters)", () => {
		const file = makeFile("active.md", { due: "2026-04-10", status: "active", tags: ["ongoing"] });
		const result = enrichOne(file, [makeTask("active.md", "Undated active")]);
		expect(result).toHaveLength(1);
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 4, 10)); // not done → inherits
	});
});

// ── 4. require tags gating ───────────────────────────────────────────────────

describe("require tags gating", () => {
	const settings = makeSettings({ requireTags: ["important"] });

	it("should inherit when the file frontmatter tags include all required tags", () => {
		const file = makeFile("has-required.md", { due: "2026-05-20", tags: ["important", "notes"] });
		const result = enrichOne(file, [makeTask("has-required.md", "Task")], settings);
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 5, 20));
	});

	it("should not inherit when a required tag is missing", () => {
		const file = makeFile("missing-required.md", { due: "2026-05-20", tags: ["notes"] });
		const result = enrichOne(file, [makeTask("missing-required.md", "Task")], settings);
		expect(result[0].dueDate).toBeNull();
	});
});

// ── 5. due with time ─────────────────────────────────────────────────────────

describe("due with time", () => {
	it("should inherit a time carried on the frontmatter due string", () => {
		const file = makeFile("due-with-time.md", { due: "2026-04-15 14:30", tags: ["meeting"] });
		const result = enrichOne(file, [makeTask("due-with-time.md", "Inherits time")]);
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 4, 15));
		expect(result[0].dueTime).toBe("14:30");
	});

	it("should keep an inline task's own time and not overwrite it", () => {
		const file = makeFile("due-with-time.md", { due: "2026-04-15 14:30" });
		const inlineEpoch = ymdToEpoch(2026, 4, 15);
		const result = enrichOne(file, [
			makeTask("due-with-time.md", "Has own time", { dueDate: inlineEpoch, dueTime: "09:00" }),
		]);
		expect(result[0].dueTime).toBe("09:00");
	});

	it("should inherit a date-only Date frontmatter value (bare YAML date)", () => {
		// Obsidian/YAML resolve a bare `due: 2026-04-15` to a UTC-midnight Date.
		const file = makeFile("bare-date.md", { due: new Date(Date.UTC(2026, 3, 15)), tags: ["work"] });
		const result = enrichOne(file, [makeTask("bare-date.md", "Bare date task")]);
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 4, 15));
		expect(result[0].dueTime).toBe("");
	});

	it("should inherit a Date frontmatter value carrying a UTC time", () => {
		const file = makeFile("dt.md", { due: new Date(Date.UTC(2026, 3, 15, 14, 30)) });
		const result = enrichOne(file, [makeTask("dt.md", "task")]);
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 4, 15));
		expect(result[0].dueTime).toBe("14:30");
	});
});

// ── 6. tag inheritance ───────────────────────────────────────────────────────

describe("tag inheritance", () => {
	it("should merge a frontmatter tags list, appending after inline tags and deduping", () => {
		const file = makeFile("tags.md", { tags: ["alpha", "beta"] });
		const result = enrichOne(file, [makeTask("tags.md", "task", { tags: ["alpha", "inline"] })]);
		// inline order preserved, frontmatter tags appended, "alpha" not duplicated
		expect(result[0].tags).toEqual(["alpha", "inline", "beta"]);
	});

	it("should ignore a scalar string tags value", () => {
		const file = makeFile("scalar-tags.md", { tags: "alpha", due: "2026-04-15" });
		const result = enrichOne(file, [makeTask("scalar-tags.md", "task", { tags: ["inline"] })]);
		expect(result[0].tags).toEqual(["inline"]); // scalar tags ignored
		expect(result[0].dueDate).toBe(ymdToEpoch(2026, 4, 15)); // due still works
	});

	it("should not mutate the input task's tags array", () => {
		const file = makeFile("tags.md", { tags: ["fm"] });
		const inputTags = ["inline"];
		const input = makeTask("tags.md", "task", { tags: inputTags });
		enrichOne(file, [input]);
		expect(inputTags).toEqual(["inline"]); // original untouched
	});
});

// ── 7. synthetic project tasks ───────────────────────────────────────────────

describe("project tasks", () => {
	it("should emit one synthetic project task for a project file and inherit due into its subtasks", () => {
		const file = makeFile("project-sort.md", { tags: ["project"], due: "2026-04-15" });
		const result = enrichOne(file, [
			makeTask("project-sort.md", "First subtask"),
			makeTask("project-sort.md", "Second subtask"),
		]);

		// 2 inherited subtasks + 1 synthetic project task (appended last)
		expect(result).toHaveLength(3);
		const subtasks = result.slice(0, 2);
		for (const sub of subtasks) {
			expect(sub.dueDate).toBe(ymdToEpoch(2026, 4, 15));
			expect(sub.tags).toEqual(["project"]);
			expect(sub.sortLast).toBe(false);
		}

		const project = result[2];
		expect(project.body).toBe("project-sort"); // basename, no extension
		expect(project.lineNumber).toBe(1);
		expect(project.status).toBe("open");
		expect(project.sortLast).toBe(true);
		expect(project.dueDate).toBe(ymdToEpoch(2026, 4, 15));
		expect(project.tags).toEqual(["project"]);
	});

	it("should not emit a project task for a done project file", () => {
		const file = makeFile("done-project.md", { tags: ["project"], due: "2026-04-15", status: "done" });
		const result = enrichTasks(new Map(), [file], makeSettings());
		expect(result).toHaveLength(0);
	});

	it("should not emit a project task for a project file without a due", () => {
		const file = makeFile("no-due-project.md", { tags: ["project"] });
		const result = enrichTasks(new Map(), [file], makeSettings());
		expect(result).toHaveLength(0);
	});

	it("should not emit a project task when the file is not tagged project", () => {
		const file = makeFile("plain.md", { tags: ["work"], due: "2026-04-15" });
		const result = enrichTasks(new Map(), [file], makeSettings());
		expect(result).toHaveLength(0);
	});

	it("should emit a project task even when require_tags would not be satisfied", () => {
		// project tagging is independent of require_tags gating
		const file = makeFile("p.md", { tags: ["project"], due: "2026-04-15" });
		const result = enrichTasks(new Map(), [file], makeSettings({ requireTags: ["important"] }));
		expect(result).toHaveLength(1);
		expect(result[0].sortLast).toBe(true);
	});
});

// ── 8. pure parse helper ─────────────────────────────────────────────────────

describe("parseFrontmatterDue", () => {
	it("should zero-pad a bare unpadded date string", () => {
		expect(parseFrontmatterDue("2026-4-1")).toEqual({ epoch: ymdToEpoch(2026, 4, 1), time: "" });
	});

	it("should split a verbatim time off the date string", () => {
		expect(parseFrontmatterDue("2026-04-15 14:30")).toEqual({
			epoch: ymdToEpoch(2026, 4, 15),
			time: "14:30",
		});
	});

	it("should reject a calendar-invalid date", () => {
		expect(parseFrontmatterDue("2026-13-01")).toBeNull();
		expect(parseFrontmatterDue("2026-02-30")).toBeNull();
	});

	it("should reject a non-date string", () => {
		expect(parseFrontmatterDue("not a date")).toBeNull();
	});
});

// ── 9. per-file enrichment parity (the incremental-scan refactor invariant) ──

describe("enrichFileTasks / projectTaskFor parity", () => {
	it("should equal the regular-task slice of enrichTasks for a single file", () => {
		const settings = makeSettings();
		const file = makeFile("p.md", { due: "2026-04-15", tags: ["work"], status: "open" });
		const tasks = [
			makeTask("p.md", "undated"),
			makeTask("p.md", "inline-dated", { dueDate: ymdToEpoch(2026, 1, 1), lineNumber: 2 }),
		];

		const viaFile = enrichFileTasks(tasks, file, settings);
		const viaAll = enrichTasks(new Map([[file.path, tasks]]), [file], settings).filter((t) => !t.sortLast);

		expect(viaFile).toEqual(viaAll);
	});

	it("should match enrichTasks' synthetic project task via projectTaskFor", () => {
		const settings = makeSettings();
		const file = makeFile("proj.md", { tags: ["project"], due: "2026-05-01" });

		const viaHelper = projectTaskFor(file, settings);
		const viaAll = enrichTasks(new Map(), [file], settings).filter((t) => t.sortLast);

		expect(viaHelper ? [viaHelper] : []).toEqual(viaAll);
	});

	it("should return null from projectTaskFor when the file is not a project", () => {
		const settings = makeSettings();
		expect(projectTaskFor(makeFile("plain.md", { tags: ["work"], due: "2026-04-15" }), settings)).toBeNull();
		expect(projectTaskFor(makeFile("none.md", null), settings)).toBeNull();
	});

	it("should reconstruct enrichTasks output by concatenating per-file enrichment (regulars, then projects)", () => {
		const settings = makeSettings();
		const f1 = makeFile("a.md", { due: "2026-04-15", tags: ["work"] });
		const f2 = makeFile("b.md", { tags: ["project"], due: "2026-05-01" }); // project-only file
		const f3 = makeFile("c.md", { status: "done", due: "2026-04-15" }); // completed → undated dropped
		const t1 = [makeTask("a.md", "a1"), makeTask("a.md", "a2", { dueDate: ymdToEpoch(2026, 3, 3), lineNumber: 2 })];
		const t3 = [makeTask("c.md", "c-undated"), makeTask("c.md", "c-dated", { dueDate: ymdToEpoch(2026, 2, 2), lineNumber: 2 })];
		const byFile = new Map([
			["a.md", t1],
			["c.md", t3],
		]);
		const files = [f1, f2, f3];

		const regulars = [
			...enrichFileTasks(t1, f1, settings),
			...enrichFileTasks(t3, f3, settings),
		];
		const projects = files
			.map((f) => projectTaskFor(f, settings))
			.filter((p): p is NonNullable<typeof p> => p !== null);
		const reconstructed = [...regulars, ...projects];

		expect(reconstructed).toEqual(enrichTasks(byFile, files, settings));
	});
});
