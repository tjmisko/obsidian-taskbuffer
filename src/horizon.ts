// horizon.ts — port of taskbuffer.nvim's horizon.lua (itself a port of
// go/horizon.go). Resolves user-facing horizon specs into ResolvedHorizons with
// comparable cutoff epochs, then buckets dated tasks into exactly one horizon
// each. The Lua implementation is authoritative; cutoff/overlap semantics mirror
// it exactly.
//
// All date math goes through dates.ts's canonical LOCAL-NOON epoch (ms)
// representation, so cutoffs are directly comparable with </>= against
// Task.dueDate and DST-safe.
//
// CUTOFF SEMANTICS: a horizon's `cutoff` is the INCLUSIVE LOWER BOUND of its
// bucket. In sorted order the bucket for horizon i is [cutoff[i], cutoff[i+1]),
// and the last dated horizon is open-ended [cutoff[last], ∞). Calendar-keyword
// cutoffs ("end_of_week" etc.) resolve to start-of-next-period, so they act as
// the lower bound of the FOLLOWING horizon — matching the Lua doc's
// "exclusive upper bound" phrasing while keeping buckets identical.
//
// Pure module — no Obsidian imports, so it runs under vitest/Node.

import { Task } from "./types";
import { HorizonSpec, OverlapMode, WeekStart, DEFAULT_HORIZONS } from "./config";
import { addDays, ymdToEpoch, epochToYMD, weekday } from "./dates";

/** A resolved dated horizon. `cutoff` is a local-noon epoch (ms), inclusive lower bound. */
export interface ResolvedHorizon {
	label: string;
	cutoff: number;
	order: number; // metadata only; list/cutoff order drives display
}

// Go time.Weekday numbering (Sunday=0 .. Saturday=6), matching dates.weekday().
const SUNDAY = 0;
const SATURDAY = 6;
const MONDAY = 1;

const WEEKDAY_NAMES: Record<string, number> = {
	sunday: SUNDAY,
	monday: MONDAY,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: SATURDAY,
};

const DURATION_MULT: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };

/** Parse a weekday name to Go time.Weekday numbering. Defaults to Monday. */
function parseWeekday(s: string): number {
	const key = String(s).trim().toLowerCase();
	const wd = WEEKDAY_NAMES[key];
	return wd === undefined ? MONDAY : wd;
}

/**
 * Parse a duration string ("2d","1w","1m","1y", negatives allowed) into a day
 * count. Units: d=1, w=7, m=30, y=365. Returns null on malformed input
 * (rejects "1dd", "d2", "2x", "2 d", " 1d", "1d ", "1D", "").
 */
function parseDuration(s: string): number | null {
	const m = /^(-?\d+)([dwmy])$/.exec(s);
	if (!m) return null;
	const n = Number.parseInt(m[1] as string, 10);
	const mult = DURATION_MULT[m[2] as string] as number;
	return n * mult;
}

/**
 * Resolve a calendar keyword to its cutoff epoch (start-of-next-period).
 * `today` is the local-noon reference day; `weekStartNum` is Go weekday numbering.
 * Returns null for an unknown keyword.
 */
function resolveCalendarKeyword(kw: string, today: number, weekStartNum: number): number | null {
	const { year, month, day } = epochToYMD(today);
	switch (kw) {
		case "past":
			// AddDate(-100, 0, 0): same month/day, 100 years earlier.
			return ymdToEpoch(year - 100, month, day);
		case "yesterday":
			return addDays(today, -1);
		case "end_of_week": {
			// Day after the last day of the current week. Go weekday numbering.
			let weekEnd = weekStartNum - 1; // Mon(1) -> Sun(0); Sun(0) -> -1
			if (weekEnd < 0) weekEnd = SATURDAY;
			const todayWday = weekday(today); // 0..6 (Sun=0), matches Go
			let daysUntilEnd = (weekEnd - todayWday + 7) % 7;
			if (daysUntilEnd === 0) daysUntilEnd = 7;
			return addDays(today, daysUntilEnd + 1);
		}
		case "end_of_month":
			// First day of next month (ymdToEpoch normalizes month=13 -> next Jan).
			return ymdToEpoch(year, month + 1, 1);
		case "end_of_quarter": {
			const qMonth = Math.floor((month - 1) / 3) * 3 + 4; // first month of next quarter
			return ymdToEpoch(year, qMonth, 1);
		}
		case "end_of_year":
			return ymdToEpoch(year + 1, 1, 1);
		default:
			return null;
	}
}

/**
 * Resolve the polymorphic `after` field to a cutoff epoch. Accepts a number
 * (day offset, truncated toward zero), a string (duration or calendar keyword),
 * or undefined. Returns null + a message on failure.
 */
function parseAfter(
	val: number | string | undefined,
	today: number,
	weekStartNum: number,
): { cutoff: number | null; err: string | null } {
	if (typeof val === "number") {
		return { cutoff: addDays(today, Math.trunc(val)), err: null };
	}
	if (typeof val === "string") {
		const days = parseDuration(val);
		if (days !== null) {
			return { cutoff: addDays(today, days), err: null };
		}
		const cutoff = resolveCalendarKeyword(val, today, weekStartNum);
		if (cutoff === null) {
			return { cutoff: null, err: `unknown calendar keyword: "${val}"` };
		}
		return { cutoff, err: null };
	}
	if (val === undefined) {
		return { cutoff: null, err: "after value is nil" };
	}
	return { cutoff: null, err: `unsupported after type: ${typeof val}` };
}

/** Normalize any epoch to local noon of its calendar day (idempotent for noon epochs). */
function startOfDayNoon(epoch: number): number {
	const { year, month, day } = epochToYMD(epoch);
	return ymdToEpoch(year, month, day);
}

/**
 * Resolve a list of horizon specs into dated ResolvedHorizons (in spec list
 * order) plus a single undated descriptor (last `undated` spec wins, mirroring
 * format.lua). Empty specs use {@link DEFAULT_HORIZONS}. Invalid dated specs are
 * warned-and-skipped; if EVERY dated spec fails, falls back to the defaults
 * entirely — exactly as horizon.lua does.
 *
 * The dated list is NOT sorted here. The Lua couples its ascending-cutoff sort
 * to the "sorted" overlap mode; since this signature carries no mode, the
 * cutoff-ascending arrangement is applied inside {@link bucketDatedTasks} for
 * "sorted" mode, keeping first_match/narrowest faithful to spec list order.
 */
export function resolveHorizons(
	specs: HorizonSpec[],
	today: number,
	weekStart: WeekStart,
): { dated: ResolvedHorizon[]; undated: { label: string; order: number } | null } {
	const weekStartNum = parseWeekday(weekStart);
	const base = startOfDayNoon(today);

	const effectiveSpecs = specs && specs.length > 0 ? specs : DEFAULT_HORIZONS;

	const dated: ResolvedHorizon[] = [];
	let undated: { label: string; order: number } | null = null;
	const parseErrors: string[] = [];

	effectiveSpecs.forEach((s, idx) => {
		if (s.undated) {
			const order = s.order ?? effectiveSpecs.length + idx;
			undated = { label: s.label, order }; // last undated wins
			return;
		}
		const { cutoff, err } = parseAfter(s.after, base, weekStartNum);
		if (err !== null || cutoff === null) {
			parseErrors.push(`horizon "${s.label}": ${err}`);
			return;
		}
		const order = s.order ?? idx;
		dated.push({ label: s.label, cutoff, order });
	});

	if (parseErrors.length > 0) {
		for (const e of parseErrors) {
			console.warn("taskbuffer: warning: " + e);
		}
		if (dated.length === 0) {
			// Every dated spec failed: fall back to the built-in defaults entirely.
			return resolveHorizons(DEFAULT_HORIZONS, today, weekStart);
		}
	}

	return { dated, undated };
}

/** Is `date` inside dated horizon `i` (0-based)? The last horizon is open-ended. */
function inHorizon(date: number, i: number, horizons: ResolvedHorizon[]): boolean {
	const h = horizons[i];
	if (!h) return false;
	if (i === horizons.length - 1) return date >= h.cutoff;
	const next = horizons[i + 1];
	if (!next) return date >= h.cutoff;
	return date >= h.cutoff && date < next.cutoff;
}

/** First horizon (in list order) whose cutoff `date` reaches; else the last. */
function firstMatchHorizon(date: number, horizons: ResolvedHorizon[]): number {
	for (let i = 0; i < horizons.length; i++) {
		const h = horizons[i];
		if (h && date >= h.cutoff) return i;
	}
	return horizons.length - 1;
}

/** Horizon with the tightest range containing `date`; ties resolve to earliest. */
function narrowestHorizon(date: number, horizons: ResolvedHorizon[]): number {
	let bestIdx = -1;
	let bestSpan = Infinity;
	// Open-ended span sentinel: strictly less than Infinity (so an open-ended
	// bucket is selectable) yet strictly greater than any real ms span.
	const OPEN = 2 ** 53;

	for (let i = 0; i < horizons.length; i++) {
		const h = horizons[i];
		if (!h) continue;
		let inRange = false;
		let span = 0;
		if (i === horizons.length - 1) {
			if (date >= h.cutoff) {
				inRange = true;
				span = OPEN;
			}
		} else {
			const next = horizons[i + 1];
			if (next && date >= h.cutoff && date < next.cutoff) {
				inRange = true;
				span = next.cutoff - h.cutoff;
			}
		}
		if (inRange && span < bestSpan) {
			bestSpan = span;
			bestIdx = i;
		}
	}

	return bestIdx === -1 ? horizons.length - 1 : bestIdx;
}

/**
 * Assign each dated task (dueDate != null) to exactly one dated horizon label.
 * Undated tasks are ignored (the renderer handles them separately). Returns a
 * Map keyed by horizon label, inserted in display order: cutoff-ascending for
 * "sorted", spec list order for "first_match"/"narrowest". Within-bucket task
 * order is not guaranteed (the renderer re-sorts); no task is dropped.
 *
 *  - "sorted":      sort tasks ascending by dueDate, then walk a forward-only
 *                   pointer over the cutoff-sorted horizons (stateful scan from
 *                   format.lua) so each task lands in exactly one bucket.
 *  - "first_match": first horizon (list order) whose cutoff the date reaches.
 *  - "narrowest":   tightest containing range; ties -> earliest index.
 */
export function bucketDatedTasks(
	tasks: Task[],
	dated: ResolvedHorizon[],
	mode: OverlapMode,
): Map<string, Task[]> {
	const result = new Map<string, Task[]>();
	if (dated.length === 0) return result; // nowhere to place dated tasks

	const push = (label: string, t: Task): void => {
		const arr = result.get(label);
		if (arr) {
			arr.push(t);
		} else {
			result.set(label, [t]);
		}
	};

	const datedTasks = tasks.filter((t) => t.dueDate !== null);

	if (mode === "sorted") {
		// Mirror horizon.lua sorted-mode sort: ascending by cutoff. Work on a copy.
		const sorted = [...dated].sort((a, b) => a.cutoff - b.cutoff);
		const orderedTasks = [...datedTasks].sort(
			(a, b) => (a.dueDate as number) - (b.dueDate as number),
		);
		let interval = 0; // forward-only pointer; never resets (mirrors format.lua)
		for (const t of orderedTasks) {
			const date = t.dueDate as number;
			for (let i = interval; i < sorted.length; i++) {
				if (inHorizon(date, i, sorted)) {
					interval = i;
					break;
				}
			}
			const chosen = sorted[interval];
			if (chosen) push(chosen.label, t);
		}
		return result;
	}

	for (const t of datedTasks) {
		const date = t.dueDate as number;
		const idx = mode === "first_match" ? firstMatchHorizon(date, dated) : narrowestHorizon(date, dated);
		const h = dated[idx];
		if (h) push(h.label, t);
	}
	return result;
}
