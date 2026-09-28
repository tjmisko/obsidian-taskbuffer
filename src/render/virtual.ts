// virtual.ts — pure geometry for the virtualized task list: which item sits at
// a scroll offset, and whether a probe measurement can be trusted. No DOM or
// "obsidian" import, so it is unit-tested directly under Node; view.ts feeds it
// offsets and applies the answers.

/** A flat, positioned render item. `rowIndex === undefined` means a section header. */
export interface VItem {
	top: number;
	height: number;
	section?: string;
	rowIndex?: number;
}

/** Uniform heights the virtualizer lays rows out with. */
export interface Measurement {
	rowH: number;
	sectionH: number;
}

/** Used until a visible probe has produced a real measurement. */
export const FALLBACK_MEASUREMENT: Measurement = { rowH: 44, sectionH: 22 };

/** Smallest item index whose bottom edge is below `y`. Items must be sorted by top. */
export function firstVisibleItem(items: readonly VItem[], y: number): number {
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const it = items[mid] as VItem;
		if (it.top + it.height > y) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * Decide which heights to lay out with after probing. A probe measured while
 * the view is hidden (an inactive tab is `display: none`) reads 0; laying rows
 * out at a fallback height then clips their text, so keep the last trusted
 * measurement and report `stale` so the view re-measures once it is shown.
 */
export function resolveMeasurement(
	probe: Measurement,
	previous: Measurement | null,
): Measurement & { stale: boolean } {
	if (probe.rowH > 0 && probe.sectionH > 0) return { ...probe, stale: false };
	return { ...(previous ?? FALLBACK_MEASUREMENT), stale: true };
}
