import { describe, it, expect } from "vitest";
import { tokenizeInline, InlineToken } from "../src/render/inline";

describe("tokenizeInline", () => {
	it("should return a single text token when there is no markup", () => {
		expect(tokenizeInline("Take a passport photo")).toEqual([{ kind: "text", text: "Take a passport photo" }]);
	});

	it("should render a bare wikilink, dropping the brackets", () => {
		expect(tokenizeInline("Ask Cody about [[The Commons]]")).toEqual([
			{ kind: "text", text: "Ask Cody about " },
			{ kind: "wikilink", text: "The Commons", target: "The Commons" },
		]);
	});

	it("should display the alias and link the target for a piped wikilink", () => {
		expect(tokenizeInline("[[2026-02-09|today]]")).toEqual([{ kind: "wikilink", text: "today", target: "2026-02-09" }]);
	});

	it("should keep the heading on the target of a heading wikilink", () => {
		expect(tokenizeInline("[[Note#Section]]")).toEqual([{ kind: "wikilink", text: "Note#Section", target: "Note#Section" }]);
	});

	it("should render an inline code span", () => {
		expect(tokenizeInline("Record a video for `taskbuffer.nvim`")).toEqual([
			{ kind: "text", text: "Record a video for " },
			{ kind: "code", text: "taskbuffer.nvim" },
		]);
	});

	it("should not format inside a code span", () => {
		expect(tokenizeInline("`a *b* c`")).toEqual([{ kind: "code", text: "a *b* c" }]);
	});

	it("should render bold with either delimiter", () => {
		expect(tokenizeInline("**loud**")).toEqual([{ kind: "bold", text: "loud" }]);
		expect(tokenizeInline("__loud__")).toEqual([{ kind: "bold", text: "loud" }]);
	});

	it("should render italic with either delimiter", () => {
		expect(tokenizeInline("*soft*")).toEqual([{ kind: "italic", text: "soft" }]);
		expect(tokenizeInline("a _soft_ word")).toEqual([
			{ kind: "text", text: "a " },
			{ kind: "italic", text: "soft" },
			{ kind: "text", text: " word" },
		]);
	});

	it("should prefer bold over italic for a doubled delimiter", () => {
		expect(tokenizeInline("**x**")).toEqual([{ kind: "bold", text: "x" }]);
	});

	it("should leave a mid-word underscore literal", () => {
		expect(tokenizeInline("snake_case_name")).toEqual([{ kind: "text", text: "snake_case_name" }]);
	});

	it("should render strikethrough", () => {
		expect(tokenizeInline("~~done~~")).toEqual([{ kind: "strike", text: "done" }]);
	});

	it("should render a markdown link with its text and href", () => {
		expect(tokenizeInline("see [docs](https://example.com)")).toEqual([
			{ kind: "text", text: "see " },
			{ kind: "link", text: "docs", href: "https://example.com" },
		]);
	});

	it("should interleave several constructs in order", () => {
		const tokens = tokenizeInline("Fix `bug` in [[Engine]] **now**");
		expect(tokens).toEqual<InlineToken[]>([
			{ kind: "text", text: "Fix " },
			{ kind: "code", text: "bug" },
			{ kind: "text", text: " in " },
			{ kind: "wikilink", text: "Engine", target: "Engine" },
			{ kind: "text", text: " " },
			{ kind: "bold", text: "now" },
		]);
	});

	it("should leave an unterminated delimiter as plain text", () => {
		expect(tokenizeInline("a `b and [[c")).toEqual([{ kind: "text", text: "a `b and [[c" }]);
	});

	it("should return an empty list for an empty string", () => {
		expect(tokenizeInline("")).toEqual([]);
	});
});
