import { describe, it, expect } from "vitest";
import {
	FALLBACK_MEASUREMENT,
	SectionMark,
	VItem,
	firstVisibleItem,
	resolveMeasurement,
	stickyHeader,
} from "../src/render/virtual";

const SECTION_H = 20;
const ROW_H = 50;

/** Build items + section marks for sections of the given row counts. */
function layout(counts: Array<[string, number]>): { items: VItem[]; sections: SectionMark[] } {
	const items: VItem[] = [];
	const sections: SectionMark[] = [];
	let top = 0;
	let rowIndex = 0;
	for (const [label, n] of counts) {
		items.push({ top, height: SECTION_H, section: label });
		sections.push({ top, label });
		top += SECTION_H;
		for (let i = 0; i < n; i++) {
			items.push({ top, height: ROW_H, rowIndex: rowIndex++ });
			top += ROW_H;
		}
	}
	return { items, sections };
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

describe("stickyHeader", () => {
	// Overdue @0 (rows 20..170), Today @170 (rows 190..290), Later @290.
	const { sections } = layout([["Overdue", 3], ["Today", 2], ["Later", 1]]);

	it("should pin nothing when the list is not scrolled", () => {
		expect(stickyHeader(sections, 0, SECTION_H)).toBeNull();
	});

	it("should pin nothing when there are no sections", () => {
		expect(stickyHeader([], 300, SECTION_H)).toBeNull();
	});

	it("should pin the first section when scrolled into its rows", () => {
		expect(stickyHeader(sections, 60, SECTION_H)).toEqual({ label: "Overdue", offset: 0 });
	});

	it("should pin the section whose rows are under the top edge when there are many rows", () => {
		expect(stickyHeader(sections, 200, SECTION_H)).toEqual({ label: "Today", offset: 0 });
	});

	it("should push the pinned header up when the next header approaches", () => {
		// Today's header is at 170; at y=160 it sits 10px below the top, so the
		// 20px pinned Overdue header must slide up by 10.
		expect(stickyHeader(sections, 160, SECTION_H)).toEqual({ label: "Overdue", offset: -10 });
	});

	it("should hand over to the next section exactly when its header reaches the top", () => {
		expect(stickyHeader(sections, 170, SECTION_H)).toEqual({ label: "Today", offset: 0 });
	});

	it("should never push by more than the header height", () => {
		const s = stickyHeader(sections, 169.5, SECTION_H);
		expect(s?.label).toBe("Overdue");
		expect(s?.offset).toBeGreaterThanOrEqual(-SECTION_H);
	});

	it("should keep the last section pinned with no offset when scrolled past everything", () => {
		expect(stickyHeader(sections, 5_000, SECTION_H)).toEqual({ label: "Later", offset: 0 });
	});

	it("should pin an empty-rowed section correctly when two headers are adjacent", () => {
		const adjacent = layout([["Overdue", 0], ["Today", 2]]).sections; // Today @20
		expect(stickyHeader(adjacent, 5, SECTION_H)).toEqual({ label: "Overdue", offset: -5 });
		expect(stickyHeader(adjacent, 25, SECTION_H)).toEqual({ label: "Today", offset: 0 });
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
