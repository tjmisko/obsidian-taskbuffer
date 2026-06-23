import { describe, it, expect } from "vitest";
import { describeMarkers } from "../src/render/markers";
import { Marker } from "../src/types";

function m(kind: string, date = "", time = ""): Marker {
	return { kind, date, time };
}

describe("describeMarkers", () => {
	it("should return an empty log when there are no markers", () => {
		expect(describeMarkers([])).toEqual([]);
	});

	it("should map known kinds to glyph + label, keeping date/time verbatim", () => {
		const log = describeMarkers([m("original", "2026-06-18"), m("complete", "2026-06-23", "09:00")]);
		expect(log).toEqual([
			{ glyph: "⟲", label: "originally due", when: "2026-06-18", kind: "original" },
			{ glyph: "✓", label: "completed", when: "2026-06-23 09:00", kind: "complete" },
		]);
	});

	it("should collapse repeated deferrals into a single dated entry", () => {
		const log = describeMarkers([
			m("original", "2026-06-18"),
			m("deferral", "2026-06-20", "10:00"),
			m("deferral", "2026-06-22", "11:00"),
			m("deferral", "2026-06-24", "12:00"),
		]);
		const deferral = log.find((e) => e.kind === "deferral");
		expect(deferral).toEqual({ glyph: "→", label: "deferred ×3", when: "2026-06-24 12:00", kind: "deferral" });
		// only the original + the single collapsed deferral remain
		expect(log).toHaveLength(2);
	});

	it("should not pluralize a single deferral", () => {
		const log = describeMarkers([m("deferral", "2026-06-24")]);
		expect(log).toEqual([{ glyph: "→", label: "deferred", when: "2026-06-24", kind: "deferral" }]);
	});

	it("should fall back to a neutral glyph and the raw kind for unknown markers", () => {
		const log = describeMarkers([m("snoozed", "2026-06-24")]);
		expect(log).toEqual([{ glyph: "·", label: "snoozed", when: "2026-06-24", kind: "snoozed" }]);
	});

	it("should trim the when field when a marker has no date or time", () => {
		const log = describeMarkers([m("start")]);
		expect(log[0]!.when).toBe("");
	});
});
