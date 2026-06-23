import { describe, it, expect } from "vitest";
import * as actions from "../src/actions";
import { buildParseContext } from "../src/parse/parse";
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
