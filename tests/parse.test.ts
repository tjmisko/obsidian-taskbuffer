// Ported from taskbuffer.nvim tests/unit/parse_spec.lua (itself from go/parse_test.go,
// parse_adversarial_test.go, date_validation_test.go). The behavioral contract.
// API differences: parseTask returns Task | null (no error string); config keys
// are camelCase; due dates compared via formatEpoch(dueDate, "%Y-%m-%d").

import { describe, it, expect } from "vitest";
import { buildParseContext, parseTask, parseTasks, RawMatch, ParseContext } from "../src/parse/parse";
import { formatEpoch } from "../src/parse/strftime";
import { mergeSettings } from "../src/config";
import { Task } from "../src/types";

function ctxWith(overrides: Record<string, unknown> = {}, collectErrors = false): ParseContext {
	return buildParseContext(mergeSettings(overrides), collectErrors);
}
const defaultCtx = ctxWith();

function rm(text: string, path = "adversarial.md", lineNumber = 1): RawMatch {
	return { path, lineNumber, text };
}

function dueIso(task: Task): string | null {
	return task.dueDate === null ? null : formatEpoch(task.dueDate, "%Y-%m-%d");
}

describe("parseTask — core", () => {
	it("parses a simple dated task", () => {
		const t = parseTask(rm("- [ ] Buy groceries (@[[2026-02-17]])"), defaultCtx)!;
		expect(t).not.toBeNull();
		expect(t.body).toBe("Buy groceries");
		expect(t.status).toBe("open");
		expect(dueIso(t)).toBe("2026-02-17");
		expect(t.dueTime).toBe("");
		expect(t.duration).toBe("");
		expect(t.tags).toEqual([]);
		expect(t.markers).toEqual([]);
		expect(t.sortLast).toBe(false);
	});

	it("captures the due time", () => {
		const t = parseTask(rm("- [ ] Team meeting (@[[2026-02-17]] 16:00)"), defaultCtx)!;
		expect(t.body).toBe("Team meeting");
		expect(t.dueTime).toBe("16:00");
	});

	it("captures duration", () => {
		const t = parseTask(rm("- [ ] Meeting with Professor <90m> (@[[2026-02-17]])"), defaultCtx)!;
		expect(t.body).toBe("Meeting with Professor");
		expect(t.duration).toBe("90m");
	});

	it("captures tags", () => {
		const t = parseTask(rm("- [ ] Run 5k #exercise #target (@[[2026-02-17]])"), defaultCtx)!;
		expect(t.body).toBe("Run 5k");
		expect(t.tags).toEqual(["exercise", "target"]);
	});

	it("parses original + deferral markers", () => {
		const t = parseTask(
			rm("- [ ] Some task (@[[2026-01-21]])::original [[2026-01-14]] ::deferral [[2026-01-21]] 12:03"),
			defaultCtx,
		)!;
		expect(t.markers).toEqual([
			{ kind: "original", date: "2026-01-14", time: "" },
			{ kind: "deferral", date: "2026-01-21", time: "12:03" },
		]);
	});

	it("parses start/stop markers and done status", () => {
		const t = parseTask(
			rm("- [x] Write report (@[[2026-01-14]]) ::start [[2026-01-14]] 15:58 ::stop [[2026-01-14]] 16:40"),
			defaultCtx,
		)!;
		expect(t.status).toBe("done");
		expect(t.markers.map((m) => [m.kind, m.time])).toEqual([
			["start", "15:58"],
			["stop", "16:40"],
		]);
	});

	it("trims an indented / tab-led line", () => {
		const t = parseTask(rm("\t- [ ] Indented task (@[[2026-02-17]])\n"), defaultCtx)!;
		expect(t.body).toBe("Indented task");
	});

	it("keeps wikilinks in the body", () => {
		const t = parseTask(rm("- [ ] Visit [[The Commons]] for lunch (@[[2026-02-17]])"), defaultCtx)!;
		expect(t.body).toBe("Visit [[The Commons]] for lunch");
	});

	it("strips a wikilink alias from the date", () => {
		const t = parseTask(rm("- [ ] Aliased task (@[[1749970209-GXKH|2025-06-15]])"), defaultCtx)!;
		expect(dueIso(t)).toBe("2025-06-15");
	});

	it("strips a path prefix from the date", () => {
		const t = parseTask(rm("- [ ] Path prefix task (@[[daily/2025-06-13]])"), defaultCtx)!;
		expect(dueIso(t)).toBe("2025-06-13");
	});

	it("treats an empty date (@[[]]) as undated and keeps it in the body", () => {
		const t = parseTask(rm("- [ ] Broken task (@[[]])"), defaultCtx)!;
		expect(t.dueDate).toBeNull();
		expect(t.body).toBe("Broken task (@[[]])");
	});

	it("handles no-space markers and a hyphenated tag", () => {
		const t = parseTask(rm("- [x] Buy screws (@[[2026-01-28]]) #fish-tank::complete [[2026-01-29]] 09:16"), defaultCtx)!;
		expect(t.tags).toEqual(["fish-tank"]);
		expect(t.markers).toHaveLength(1);
		expect(t.markers[0]!.kind).toBe("complete");
	});

	it("parses a full complex line", () => {
		const t = parseTask(
			rm(
				"- [x] Rewrite About Me Section <30m> (@[[2026-01-23]] 15:00) ::start [[2026-01-23]] 15:17::complete [[2026-01-23]] 17:19",
			),
			defaultCtx,
		)!;
		expect(t.status).toBe("done");
		expect(t.body).toBe("Rewrite About Me Section");
		expect(t.duration).toBe("30m");
		expect(t.dueTime).toBe("15:00");
		expect(dueIso(t)).toBe("2026-01-23");
		expect(t.markers).toEqual([
			{ kind: "start", date: "2026-01-23", time: "15:17" },
			{ kind: "complete", date: "2026-01-23", time: "17:19" },
		]);
	});

	it("parses irrelevant status", () => {
		const t = parseTask(rm("- [-] Cancelled task (@[[2024-11-25]])"), defaultCtx)!;
		expect(t.status).toBe("irrelevant");
	});

	it("keeps a marker's stripped raw path-prefix date", () => {
		const t = parseTask(rm("- [x] Backend docs <60m> (@[[2025-05-31]])::complete [[daily/2025-06-13]] 08:50"), defaultCtx)!;
		expect(t.markers).toHaveLength(1);
		expect(t.markers[0]!.date).toBe("2025-06-13");
	});

	it("parses an undated task", () => {
		const t = parseTask(rm("- [ ] Investigate OOM Kill Root Cause"), defaultCtx)!;
		expect(t.dueDate).toBeNull();
		expect(t.body).toBe("Investigate OOM Kill Root Cause");
		expect(t.status).toBe("open");
		expect(t.dueTime).toBe("");
	});

	it("parses an undated task with tags and duration", () => {
		const t1 = parseTask(rm("- [ ] Fix memory leak #backend #urgent"), defaultCtx)!;
		expect(t1.dueDate).toBeNull();
		expect(t1.body).toBe("Fix memory leak");
		expect(t1.tags).toEqual(["backend", "urgent"]);
		const t2 = parseTask(rm("- [ ] Research caching strategies <60m>"), defaultCtx)!;
		expect(t2.duration).toBe("60m");
		expect(t2.body).toBe("Research caching strategies");
	});

	it("returns null when there is no checkbox", () => {
		expect(parseTask(rm("Not a task line"), defaultCtx)).toBeNull();
	});
});

describe("parseTasks", () => {
	it("skips unparseable lines", () => {
		const tasks = parseTasks(
			[
				rm("- [ ] Good task (@[[2026-02-17]])", "a.md", 1),
				rm("not a task line at all", "b.md", 2),
				rm("- [ ] Also good (@[[2026-02-18]])", "c.md", 3),
			],
			defaultCtx,
		);
		expect(tasks).toHaveLength(2);
	});
});

describe("custom date / time formats", () => {
	it("parses US date %m/%d/%Y", () => {
		const ctx = ctxWith({ formats: { date: "%m/%d/%Y", dateWrapper: ["(@[[", "]]", ")"] } });
		const t = parseTask(rm("- [ ] Task (@[[03/04/2026]])"), ctx)!;
		expect(t.body).toBe("Task");
		expect(dueIso(t)).toBe("2026-03-04");
	});

	it("parses US date with 24h time", () => {
		const ctx = ctxWith({ formats: { date: "%m/%d/%Y", time: "%H:%M", dateWrapper: ["(@[[", "]]", ")"] } });
		const t = parseTask(rm("- [ ] Task (@[[03/04/2026]] 13:00)"), ctx)!;
		expect(dueIso(t)).toBe("2026-03-04");
		expect(t.dueTime).toBe("13:00");
	});

	it("keeps a verbatim 12-hour time", () => {
		const ctx = ctxWith({ formats: { date: "%Y-%m-%d", time: "%I:%M %p", dateWrapper: ["(@[[", "]]", ")"] } });
		const t = parseTask(rm("- [ ] Task (@[[2026-03-04]] 1:00 PM)"), ctx)!;
		expect(t.dueTime).toBe("1:00 PM");
	});

	it("treats a dot separator as literal, not wildcard", () => {
		const ctx = ctxWith({ formats: { date: "%d.%m.%Y", dateWrapper: ["(@[[", "]]", ")"] } });
		expect(dueIso(parseTask(rm("- [ ] Task (@[[04.03.2026]])"), ctx)!)).toBe("2026-03-04");
		const t2 = parseTask(rm("- [ ] Task (@[[04X03X2026]])"), ctx)!;
		expect(t2.dueDate).toBeNull();
	});

	it("parses a compact format %Y%m%d", () => {
		const ctx = ctxWith({ formats: { date: "%Y%m%d", dateWrapper: ["(@[[", "]]", ")"] } });
		expect(dueIso(parseTask(rm("- [ ] Task (@[[20260304]])"), ctx)!)).toBe("2026-03-04");
	});

	it("does not capture a date in the body", () => {
		const ctx = ctxWith({ formats: { date: "%m/%d/%Y", dateWrapper: ["(@[[", "]]", ")"] } });
		const t = parseTask(rm("- [ ] Meeting re: 01/01/2026 invoice (@[[03/04/2026]])"), ctx)!;
		expect(t.body).toBe("Meeting re: 01/01/2026 invoice");
		expect(dueIso(t)).toBe("2026-03-04");
	});

	it("keeps raw marker date/time with a custom format", () => {
		const ctx = ctxWith({ formats: { date: "%m/%d/%Y", time: "%I:%M %p", dateWrapper: ["(@[[", "]]", ")"] } });
		const t = parseTask(
			rm("- [x] Task (@[[03/04/2026]]) ::start [[03/04/2026]] 1:00 PM ::complete [[03/04/2026]] 2:30 PM"),
			ctx,
		)!;
		expect(t.markers).toEqual([
			{ kind: "start", date: "03/04/2026", time: "1:00 PM" },
			{ kind: "complete", date: "03/04/2026", time: "2:30 PM" },
		]);
	});
});

describe("adversarial", () => {
	it("longest-first prefix prevents a short checkbox shadowing a long one", () => {
		const cases = [
			{ cb: { open: "- [ ]", bullet: "- " }, input: "- [ ] Real task", status: "open", body: "Real task" },
			{ cb: { open: "* [ ]", bullet: "* " }, input: "* [ ] Star task", status: "open", body: "Star task" },
			{ cb: { open: "* [ ]", done: "* [x]" }, input: "* [x] Done", status: "done", body: "Done" },
		];
		for (const c of cases) {
			const ctx = ctxWith({ formats: { checkbox: c.cb } });
			const t = parseTask(rm(c.input), ctx)!;
			expect(t.status).toBe(c.status);
			expect(t.body).toBe(c.body);
		}
	});

	it("filters empty / whitespace-only checkbox strings", () => {
		const ctx = ctxWith({ formats: { checkbox: { open: "", done: "- [x]" } } });
		for (const input of ["Hello world", "# Not a task", ""]) {
			expect(parseTask(rm(input), ctx)).toBeNull();
		}
	});

	it("resolves a duplicate checkbox glyph to the alphabetically-first name", () => {
		const cfg = { formats: { checkbox: { alpha: "- [ ]", charlie: "- [ ]", bravo: "- [x]" } } };
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			seen.add(parseTask(rm("- [ ] Test task"), ctxWith(cfg))!.status);
		}
		expect(seen.has("alpha")).toBe(true);
		expect(seen.has("charlie")).toBe(false);
	});

	it("applies default tag / marker prefixes on fallback", () => {
		const cases = [
			{ cfg: {}, tag: "#", marker: "::" },
			{ cfg: { formats: { dateWrapper: ["{"] } }, tag: "#", marker: "::" },
			{ cfg: { formats: { dateWrapper: ["", ""] } }, tag: "#", marker: "::" },
			{ cfg: { formats: { tagPrefix: "+" } }, tag: "+", marker: "::" },
		];
		for (const c of cases) {
			const ctx = ctxWith(c.cfg);
			expect(ctx.tagPrefix).toBe(c.tag);
			expect(ctx.markerPrefix).toBe(c.marker);
		}
	});

	it("falls back to default wrapper for a single-element wrapper", () => {
		const ctx = ctxWith({ formats: { dateWrapper: ["{"] } });
		expect(dueIso(parseTask(rm("- [ ] Task (@[[2026-02-17]])"), ctx)!)).toBe("2026-02-17");
	});

	it("does not let a body :: truncate the body", () => {
		const cases = [
			{ input: "- [ ] Fix std::vector crash", body: "Fix std::vector crash" },
			{ input: "- [ ] Refactor Vec::new() call", body: "Refactor Vec::new() call" },
			{ input: "- [ ] Check http://localhost::8080/health", body: "Check http://localhost::8080/health" },
			{ input: "- [ ] Fix std::vector crash (@[[2026-02-17]])", body: "Fix std::vector crash" },
		];
		for (const c of cases) {
			expect(parseTask(rm(c.input), defaultCtx)!.body).toBe(c.body);
		}
	});

	it("does not let a single-colon marker prefix truncate 'Note: fix bug'", () => {
		const ctx = ctxWith({ formats: { markerPrefix: ":" } });
		expect(parseTask(rm("- [ ] Note: fix bug"), ctx)!.body).toBe("Note: fix bug");
		expect(parseTask(rm("- [ ] Note: fix bug (@[[2026-02-17]])"), ctx)!.body).toBe("Note: fix bug");
	});

	it("ignores a custom wrapper for markers (always [[ ]])", () => {
		const ctx = ctxWith({ formats: { dateWrapper: ["{", "}"] } });
		const ok = parseTask(rm("- [ ] Task {2026-02-17} ::start [[2026-02-17]] 15:00"), ctx)!;
		expect(ok.markers).toHaveLength(1);
		expect(ok.markers[0]!.kind).toBe("start");
		const none = parseTask(rm("- [ ] Task {2026-02-17} ::start {2026-02-17} 15:00"), ctx)!;
		expect(none.markers).toHaveLength(0);
	});

	it("takes the leftmost of multiple date groups", () => {
		const t = parseTask(rm("- [ ] Compare (@[[2026-02-17]]) vs (@[[2026-03-01]])"), defaultCtx)!;
		expect(dueIso(t)).toBe("2026-02-17");
		expect(t.body).toBe("Compare");
	});

	it("errors on invalid inline dates in non-strict mode", () => {
		const cases = [
			{ input: "- [ ] Task (@[[2026-13-01]])", wantNull: true },
			{ input: "- [ ] Task (@[[2026-01-32]])", wantNull: true },
			{ input: "- [ ] Task (@[[2026-00-15]])", wantNull: true },
			{ input: "- [ ] Task (@[[2024-02-29]])", wantNull: false },
			{ input: "- [ ] Task (@[[2025-02-29]])", wantNull: true },
		];
		for (const c of cases) {
			const t = parseTask(rm(c.input), defaultCtx);
			if (c.wantNull) expect(t).toBeNull();
			else expect(t).not.toBeNull();
		}
	});
});

describe("strict date validation", () => {
	const invalidDates = [
		"2026-00-15",
		"2026-13-01",
		"2026-99-01",
		"2026-01-00",
		"2026-01-32",
		"2026-01-99",
		"2026-04-31",
		"2026-06-31",
		"2026-09-31",
		"2026-11-31",
		"2026-02-30",
		"2026-02-31",
		"2025-02-29",
		"2100-02-29",
	];
	const validDates = ["2026-01-01", "2026-12-31", "2025-02-28", "2024-02-29", "2000-02-29", "2026-04-30", "2026-06-30"];

	it("strict inline: due null, one DateError per invalid date, body/tags preserved", () => {
		for (const ds of invalidDates) {
			const ctx = ctxWith({ strict: true }, true);
			const t = parseTask(rm(`- [ ] Task #work (@[[${ds}]])`, "adversarial.md", 1), ctx)!;
			expect(t).not.toBeNull();
			expect(t.dueDate).toBeNull();
			expect(t.tags).toEqual(["work"]);
			expect(ctx.dateErrors).toHaveLength(1);
			const de = ctx.dateErrors![0]!;
			expect(de.dateStr).toBe(ds);
			expect(de.context).toBe("inline due date");
			expect(de.filePath).toBe("adversarial.md");
			expect(de.lineNumber).toBe(1);
		}
	});

	it("strict inline: valid dates set due and collect no errors", () => {
		for (const ds of validDates) {
			const ctx = ctxWith({ strict: true }, true);
			const t = parseTask(rm(`- [ ] Task (@[[${ds}]])`), ctx)!;
			expect(t.dueDate).not.toBeNull();
			expect(ctx.dateErrors).toHaveLength(0);
		}
	});

	it("strict marker: stores raw date, collects 'marker (start)' error, inline still parses", () => {
		for (const ds of invalidDates) {
			const ctx = ctxWith({ strict: true }, true);
			const t = parseTask(rm(`- [ ] Task (@[[2026-01-15]]) ::start [[${ds}]] 10:00`), ctx)!;
			expect(t.dueDate).not.toBeNull();
			expect(t.markers).toHaveLength(1);
			expect(t.markers[0]!.date).toBe(ds);
			expect(ctx.dateErrors).toHaveLength(1);
			expect(ctx.dateErrors![0]!.context).toBe("marker (start)");
		}
	});

	it("non-strict marker: stores raw invalid date with no complaint", () => {
		const t = parseTask(rm("- [ ] Task (@[[2026-01-15]]) ::start [[2026-13-45]] 10:00"), defaultCtx)!;
		expect(t.markers[0]!.date).toBe("2026-13-45");
	});

	it("strict: errors accumulate across inline and marker surfaces in one context", () => {
		const ctx = ctxWith({ strict: true }, true);
		parseTask(rm("- [ ] Task one (@[[2026-13-01]])"), ctx);
		parseTask(rm("- [ ] Task two (@[[2026-01-15]]) ::start [[2026-04-31]] 10:00"), ctx);
		expect(ctx.dateErrors).toHaveLength(2);
		const contexts = ctx.dateErrors!.map((e) => e.context);
		expect(contexts).toContain("inline due date");
		expect(contexts).toContain("marker (start)");
	});

	it("strict does not suppress missing-checkbox skips", () => {
		const ctx = ctxWith({ strict: true }, true);
		expect(parseTask(rm("Not a task line"), ctx)).toBeNull();
		expect(ctx.dateErrors).toHaveLength(0);
	});

	it("null collector in strict mode does not throw on invalid date", () => {
		const ctx = ctxWith({ strict: true }, false); // dateErrors null
		const t = parseTask(rm("- [ ] Task (@[[2026-13-01]])"), ctx)!;
		expect(t).not.toBeNull();
		expect(t.dueDate).toBeNull();
	});
});
