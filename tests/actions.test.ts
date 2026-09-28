import { describe, it, expect } from "vitest";
import * as actions from "../src/actions";
import { buildParseContext, parseTask } from "../src/parse/parse";
import { ymdToEpoch } from "../src/dates";
import { mergeSettings } from "../src/config";

const ctx = buildParseContext(mergeSettings({}));
// 2026-01-23 15:17 local.
const NOW = new Date(2026, 0, 23, 15, 17, 0, 0).getTime();

describe("action verbs (byte-exact order)", () => {
	it("completeAt appends ::complete then flips open -> done", () => {
		expect(actions.completeAt("- [ ] Task (@[[2026-01-23]])", 1, ctx, NOW)).toBe(
			"- [x] Task (@[[2026-01-23]]) ::complete [[2026-01-23]] 15:17 ",
		);
	});

	it("defer records ::original (once) then ::deferral, leaving the due date", () => {
		const once = actions.defer("- [ ] Task (@[[2026-01-23]])", 1, ctx, NOW);
		expect(once).toBe("- [ ] Task (@[[2026-01-23]]) ::original [[2026-01-23]] ::deferral [[2026-01-23]] 15:17 ");
		// A second defer must NOT add another ::original.
		const twice = actions.defer(once, 1, ctx, NOW);
		expect(twice).toBe(
			"- [ ] Task (@[[2026-01-23]]) ::original [[2026-01-23]] ::deferral [[2026-01-23]] 15:17 ::deferral [[2026-01-23]] 15:17 ",
		);
	});

	it("check flips open -> done with no marker", () => {
		expect(actions.check("- [ ] Task (@[[2026-01-23]])", 1, ctx)).toBe("- [x] Task (@[[2026-01-23]])");
	});

	it("irrelevant flips open -> irrelevant then appends ::irrelevant", () => {
		expect(actions.irrelevant("- [ ] Task (@[[2026-01-23]])", 1, ctx, NOW)).toBe(
			"- [-] Task (@[[2026-01-23]]) ::irrelevant [[2026-01-23]] 15:17 ",
		);
	});

	it("unset removes the last ::irrelevant and restores open", () => {
		const irrelevant = actions.irrelevant("- [ ] Task (@[[2026-01-23]])", 1, ctx, NOW);
		expect(actions.unset(irrelevant, 1, ctx)).toBe("- [ ] Task (@[[2026-01-23]])");
	});

	it("unset is a no-op when there is no ::irrelevant marker", () => {
		const line = "- [ ] Task (@[[2026-01-23]])";
		expect(actions.unset(line, 1, ctx)).toBe(line);
	});

	it("newTaskLine builds an open-status line", () => {
		expect(actions.newTaskLine("Buy milk", ctx)).toBe("- [ ] Buy milk");
	});
});

describe("setDueOnLine", () => {
	const reparse = (line: string, c = ctx) => parseTask({ path: "f.md", lineNumber: 1, text: line }, c);

	it("should replace only the date substring when the line already has a due date", () => {
		expect(actions.setDueOnLine("- [ ] Task (@[[2026-01-23]]) #a", ctx, "2026-02-01")).toBe(
			"- [ ] Task (@[[2026-02-01]]) #a",
		);
	});

	it("should preserve the due time when the dated line carries one", () => {
		expect(actions.setDueOnLine("- [ ] Task (@[[2026-01-23]] 16:00)", ctx, "2026-02-01")).toBe(
			"- [ ] Task (@[[2026-02-01]] 16:00)",
		);
	});

	it("should keep a wikilink path prefix when the due date links into a folder", () => {
		expect(actions.setDueOnLine("- [ ] Task (@[[daily/2026-01-23]])", ctx, "2026-02-01")).toBe(
			"- [ ] Task (@[[daily/2026-02-01]])",
		);
	});

	it("should append a wrapped due date when the line is undated and has no markers", () => {
		expect(actions.setDueOnLine("- [ ] Task #a  ", ctx, "2026-02-01")).toBe("- [ ] Task #a (@[[2026-02-01]])");
	});

	it("should insert the due date before the first marker when the undated line has markers", () => {
		expect(actions.setDueOnLine("- [ ] Task ::start [[2026-01-20]] 09:00 ::stop [[2026-01-20]] 10:00", ctx, "2026-02-01")).toBe(
			"- [ ] Task (@[[2026-02-01]]) ::start [[2026-01-20]] 09:00 ::stop [[2026-01-20]] 10:00",
		);
	});

	it("should not mistake a C++ scope operator in the body for a marker when inserting", () => {
		expect(actions.setDueOnLine("- [ ] Read std::vector docs", ctx, "2026-02-01")).toBe(
			"- [ ] Read std::vector docs (@[[2026-02-01]])",
		);
	});

	it("should use a two-element wrapper when the settings configure one", () => {
		const c2 = buildParseContext(mergeSettings({ formats: { dateWrapper: ["<", ">"] } as never }));
		const line = actions.setDueOnLine("- [ ] Task", c2, "2026-02-01");
		expect(line).toBe("- [ ] Task <2026-02-01>");
		expect(reparse(line, c2)?.dueDate).toBe(ymdToEpoch(2026, 2, 1));
	});

	it("should round-trip through the parser with body, tags, and markers intact for every line shape", () => {
		const shapes = [
			"- [ ] Task",
			"- [ ] Task #a #b",
			"- [ ] Task (@[[2025-12-31]])",
			"- [ ] Task (@[[2025-12-31]] 08:30) <30m>",
			"- [ ] Task [[Some Note]] ::start [[2026-01-20]] 09:00",
			"  - [ ] Indented task #x ::deferral [[2026-01-01]] 10:00 ",
		];
		for (const shape of shapes) {
			const before = reparse(shape);
			const after = reparse(actions.setDueOnLine(shape, ctx, "2026-02-01"));
			expect(after?.dueDate, shape).toBe(ymdToEpoch(2026, 2, 1));
			expect(after?.body, shape).toBe(before?.body);
			expect(after?.tags, shape).toEqual(before?.tags);
			expect(after?.markers, shape).toEqual(before?.markers);
			expect(after?.duration, shape).toBe(before?.duration);
			expect(after?.dueTime, shape).toBe(before?.dueTime);
		}
	});
});

describe("deferTo", () => {
	it("should record ::original with the OLD date and ::deferral, then move the due date", () => {
		expect(actions.deferTo("- [ ] Task (@[[2026-01-23]])", 1, ctx, NOW, "2026-02-01")).toBe(
			"- [ ] Task (@[[2026-02-01]]) ::original [[2026-01-23]] ::deferral [[2026-01-23]] 15:17 ",
		);
	});

	it("should keep the first ::original when a task is deferred twice", () => {
		const once = actions.deferTo("- [ ] Task (@[[2026-01-23]])", 1, ctx, NOW, "2026-02-01");
		expect(actions.deferTo(once, 1, ctx, NOW, "2026-03-01")).toBe(
			"- [ ] Task (@[[2026-03-01]]) ::original [[2026-01-23]] ::deferral [[2026-01-23]] 15:17 ::deferral [[2026-01-23]] 15:17 ",
		);
	});

	it("should insert a due date and record only ::deferral when the task was undated", () => {
		expect(actions.deferTo("- [ ] Task", 1, ctx, NOW, "2026-02-01")).toBe(
			"- [ ] Task (@[[2026-02-01]]) ::deferral [[2026-01-23]] 15:17 ",
		);
	});

	it("should touch only the target line when the file has several tasks", () => {
		const content = "# Head\n- [ ] One (@[[2026-01-23]])\n- [ ] Two (@[[2026-01-23]])\n";
		expect(actions.deferTo(content, 3, ctx, NOW, "2026-02-01")).toBe(
			"# Head\n- [ ] One (@[[2026-01-23]])\n- [ ] Two (@[[2026-02-01]]) ::original [[2026-01-23]] ::deferral [[2026-01-23]] 15:17 \n",
		);
	});

	it("should throw when the line number is out of range", () => {
		expect(() => actions.deferTo("- [ ] Task", 5, ctx, NOW, "2026-02-01")).toThrow(/out of range/);
	});
});
