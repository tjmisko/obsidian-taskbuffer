import { describe, it, expect } from "vitest";
import { FALLBACK_MEASUREMENT, VItem, firstVisibleItem, resolveMeasurement } from "../src/render/virtual";

const SECTION_H = 20;
const ROW_H = 50;

/** Build positioned items for sections of the given row counts. */
function layout(counts: Array<[string, number]>): { items: VItem[] } {
	const items: VItem[] = [];
	let top = 0;
	let rowIndex = 0;
	for (const [label, n] of counts) {
		items.push({ top, height: SECTION_H, section: label });
		top += SECTION_H;
		for (let i = 0; i < n; i++) {
			items.push({ top, height: ROW_H, rowIndex: rowIndex++ });
			top += ROW_H;
		}
	}
	return { items };
}

describe("firstVisibleItem", () => {
	const { items } = layout([["Overdue", 3], ["Today", 2]]);

	it("should return 0 when y is at or above the top", () => {
		expect(firstVisibleItem(items, 0)).toBe(0);
		expect(firstVisibleItem(items, -500)).toBe(0);
	});

	it("should return the item straddling y when y falls inside it", () => {
		expect(firstVisibleItem(items, 25)).toBe(1); // first row spans 20..70
	});

	it("should skip an item whose bottom edge is exactly y", () => {
		expect(firstVisibleItem(items, 20)).toBe(1);
	});

	it("should return items.length when y is past the end", () => {
		expect(firstVisibleItem(items, 10_000)).toBe(items.length);
	});

	it("should return 0 for an empty list", () => {
		expect(firstVisibleItem([], 100)).toBe(0);
	});
});

describe("resolveMeasurement", () => {
	it("should trust a probe with positive heights", () => {
		expect(resolveMeasurement({ rowH: 66, sectionH: 24 }, null)).toEqual({ rowH: 66, sectionH: 24, stale: false });
	});

	it("should keep the previous measurement and flag stale when the view is hidden (probe reads 0)", () => {
		expect(resolveMeasurement({ rowH: 0, sectionH: 0 }, { rowH: 66, sectionH: 24 })).toEqual({
			rowH: 66,
			sectionH: 24,
			stale: true,
		});
	});

	it("should fall back and flag stale when hidden with no previous measurement", () => {
		expect(resolveMeasurement({ rowH: 0, sectionH: 0 }, null)).toEqual({ ...FALLBACK_MEASUREMENT, stale: true });
	});

	it("should distrust a probe when only one of the heights is zero", () => {
		expect(resolveMeasurement({ rowH: 66, sectionH: 0 }, { rowH: 50, sectionH: 20 }).stale).toBe(true);
		expect(resolveMeasurement({ rowH: 0, sectionH: 24 }, { rowH: 50, sectionH: 20 }).stale).toBe(true);
	});
});
