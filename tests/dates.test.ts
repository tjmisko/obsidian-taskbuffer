import { describe, it, expect } from "vitest";
import {
	ymdToEpoch,
	epochToYMD,
	addDays,
	daysInMonth,
	isValidYMD,
	todayEpoch,
	weekday,
	epochToIsoDate,
	isoDateToEpoch,
} from "../src/dates";

describe("date helpers", () => {
	it("round-trips ymd <-> epoch at local noon", () => {
		const e = ymdToEpoch(2026, 6, 23);
		expect(epochToYMD(e)).toEqual({ year: 2026, month: 6, day: 23 });
		expect(new Date(e).getHours()).toBe(12);
	});

	it("adds days across month and year boundaries", () => {
		expect(epochToYMD(addDays(ymdToEpoch(2026, 1, 31), 1))).toEqual({ year: 2026, month: 2, day: 1 });
		expect(epochToYMD(addDays(ymdToEpoch(2026, 12, 31), 1))).toEqual({ year: 2027, month: 1, day: 1 });
		expect(epochToYMD(addDays(ymdToEpoch(2026, 3, 1), -1))).toEqual({ year: 2026, month: 2, day: 28 });
	});

	it("keeps local noon after adding days (DST-safe)", () => {
		// 2026-03-08 is a US DST spring-forward date; noon must survive.
		expect(new Date(addDays(ymdToEpoch(2026, 3, 7), 1)).getHours()).toBe(12);
	});

	it("computes days in month with leap years", () => {
		expect(daysInMonth(2026, 2)).toBe(28);
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(2026, 4)).toBe(30);
	});

	it("validates calendar dates", () => {
		expect(isValidYMD(2026, 2, 29)).toBe(false);
		expect(isValidYMD(2024, 2, 29)).toBe(true);
		expect(isValidYMD(2026, 13, 1)).toBe(false);
	});

	it("todayEpoch is local noon", () => {
		const e = todayEpoch(new Date(2026, 5, 23, 8, 30));
		expect(epochToYMD(e)).toEqual({ year: 2026, month: 6, day: 23 });
		expect(new Date(e).getHours()).toBe(12);
	});

	it("computes weekday (0=Sun)", () => {
		expect(weekday(ymdToEpoch(2026, 6, 21))).toBe(0); // Sunday
		expect(weekday(ymdToEpoch(2026, 6, 22))).toBe(1); // Monday
	});
});

describe("date input conversion", () => {
	it("should format a task epoch as zero-padded YYYY-MM-DD", () => {
		expect(epochToIsoDate(ymdToEpoch(2026, 3, 7))).toBe("2026-03-07");
	});

	it("should parse a date input value to local noon on that day", () => {
		expect(isoDateToEpoch("2026-03-07")).toBe(ymdToEpoch(2026, 3, 7));
	});

	it("should round-trip across a leap day and year boundary", () => {
		for (const [y, m, d] of [[2028, 2, 29], [2026, 12, 31], [2027, 1, 1]] as const) {
			expect(isoDateToEpoch(epochToIsoDate(ymdToEpoch(y, m, d)))).toBe(ymdToEpoch(y, m, d));
		}
	});

	it("should return null when the picker was cleared (empty value)", () => {
		expect(isoDateToEpoch("")).toBeNull();
	});

	it("should return null when the value is not a real calendar date", () => {
		expect(isoDateToEpoch("2026-02-30")).toBeNull();
		expect(isoDateToEpoch("2027-02-29")).toBeNull();
		expect(isoDateToEpoch("2026-13-01")).toBeNull();
		expect(isoDateToEpoch("2026-00-10")).toBeNull();
	});

	it("should return null when the value is malformed or has an expanded year", () => {
		expect(isoDateToEpoch("2026-3-7")).toBeNull();
		expect(isoDateToEpoch("+012026-03-07")).toBeNull();
		expect(isoDateToEpoch("2026-03-07T00:00")).toBeNull();
		expect(isoDateToEpoch(" 2026-03-07")).toBeNull();
	});
});
