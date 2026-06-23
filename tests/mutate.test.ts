import { describe, it, expect } from "vitest";
import * as mutate from "../src/mutate";

describe("appendToLine", () => {
	it("trims trailing whitespace then appends ' ' + text", () => {
		expect(mutate.appendToLine("- [ ] Task", 1, "::x [[2026-01-23]] 10:00 ")).toBe(
			"- [ ] Task ::x [[2026-01-23]] 10:00 ",
		);
		expect(mutate.appendToLine("- [ ] Task   ", 1, "M")).toBe("- [ ] Task M");
	});
	it("preserves other lines and trailing newline state", () => {
		expect(mutate.appendToLine("a\nb\nc", 2, "X")).toBe("a\nb X\nc");
		expect(mutate.appendToLine("a\nb\n", 1, "X")).toBe("a X\nb\n");
	});
	it("throws out of range", () => {
		expect(() => mutate.appendToLine("a", 2, "X")).toThrow();
	});
});

describe("changeCheckbox", () => {
	it("replaces the first occurrence, preserving indentation", () => {
		expect(mutate.changeCheckbox("- [ ] Task", 1, "- [ ]", "- [x]")).toBe("- [x] Task");
		expect(mutate.changeCheckbox("  - [ ] Task", 1, "- [ ]", "- [x]")).toBe("  - [x] Task");
	});
	it("is a no-op when 'from' is absent", () => {
		expect(mutate.changeCheckbox("- [x] Task", 1, "- [ ]", "- [x]")).toBe("- [x] Task");
	});
	it("rejects empty from/to", () => {
		expect(() => mutate.changeCheckbox("x", 1, "", "y")).toThrow();
		expect(() => mutate.changeCheckbox("x", 1, "y", "")).toThrow();
	});
});

describe("removeLastMarker", () => {
	const D = "%Y-%m-%d";
	const T = "%H:%M";
	it("removes a marker but never the inline due date", () => {
		expect(
			mutate.removeLastMarker("- [-] Task (@[[2026-01-23]]) ::irrelevant [[2026-01-23]] 15:17", 1, "irrelevant", D, T, "::"),
		).toBe("- [-] Task (@[[2026-01-23]])");
	});
	it("removes only the last occurrence", () => {
		expect(
			mutate.removeLastMarker(
				"- [-] T ::irrelevant [[2026-01-23]] 10:00 ::irrelevant [[2026-01-24]] 11:00",
				1,
				"irrelevant",
				D,
				T,
				"::",
			),
		).toBe("- [-] T ::irrelevant [[2026-01-23]] 10:00");
	});
	it("is a no-op when no such marker exists", () => {
		expect(mutate.removeLastMarker("- [ ] Task (@[[2026-01-23]])", 1, "irrelevant", D, T, "::")).toBe(
			"- [ ] Task (@[[2026-01-23]])",
		);
	});
	it("removes a marker with no time", () => {
		expect(mutate.removeLastMarker("- [-] T ::irrelevant [[2026-01-23]]", 1, "irrelevant", D, T, "::")).toBe("- [-] T");
	});
});

describe("insertAfterHeader / appendToFile", () => {
	it("inserts after a matching header", () => {
		expect(mutate.insertAfterHeader("# Inbox\n- [ ] a\n", "# Inbox", "- [ ] new")).toBe("# Inbox\n- [ ] new\n- [ ] a\n");
	});
	it("creates the file when content is null", () => {
		expect(mutate.insertAfterHeader(null, "# Inbox", "- [ ] new")).toBe("# Inbox\n- [ ] new\n");
		expect(mutate.appendToFile(null, "- [ ] new")).toBe("- [ ] new\n");
	});
	it("appends header + text when header is missing", () => {
		expect(mutate.insertAfterHeader("# Other\n", "# Inbox", "- [ ] new")).toBe("# Other\n\n# Inbox\n- [ ] new\n");
	});
	it("appendToFile preserves trailing newline state", () => {
		expect(mutate.appendToFile("a", "b")).toBe("a\nb\n");
		expect(mutate.appendToFile("a\n", "b")).toBe("a\nb\n");
	});
});
