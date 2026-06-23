import { describe, it, expect } from "vitest";
import { compile, components, validateDate, parseEpoch, formatEpoch } from "../src/parse/strftime";
import { ymdToEpoch } from "../src/dates";

describe("compile / components", () => {
	it("extracts ISO date components", () => {
		const spec = compile("%Y-%m-%d");
		expect(components("2026-03-04", spec)).toEqual({ year: 2026, month: 3, day: 4 });
		expect(components("nope", spec)).toBeNull();
	});

	it("respects field order for US dates", () => {
		const spec = compile("%m/%d/%Y");
		expect(components("03/04/2026", spec)).toEqual({ year: 2026, month: 3, day: 4 });
	});

	it("treats separators as literal", () => {
		const spec = compile("%d.%m.%Y");
		expect(components("04.03.2026", spec)).toEqual({ year: 2026, month: 3, day: 4 });
		expect(components("04X03X2026", spec)).toBeNull();
	});

	it("has no date directives for a pure time format", () => {
		const spec = compile("%H:%M");
		expect(spec.hasDate).toBe(false);
		expect(components("16:00", spec)).toBeNull();
	});
});

describe("time run regex (flexible AM/PM space)", () => {
	it("matches 12h time with or without a space before AM/PM", () => {
		const run = compile("%I:%M %p").run;
		const re = new RegExp("^" + run + "$");
		expect(re.test("1:00 PM")).toBe(true);
		expect(re.test("12:30PM")).toBe(true);
		expect(re.test("1:00  AM")).toBe(true);
		expect(re.test("13:00")).toBe(false);
	});
});

describe("validateDate", () => {
	const spec = compile("%Y-%m-%d");
	it("rejects out-of-range months and days", () => {
		expect(validateDate(components("2026-13-01", spec)).ok).toBe(false);
		expect(validateDate(components("2026-01-32", spec)).ok).toBe(false);
		expect(validateDate(components("2026-00-15", spec)).reason).toBe("month out of range");
	});
	it("honors leap years", () => {
		expect(validateDate(components("2024-02-29", spec)).ok).toBe(true);
		expect(validateDate(components("2025-02-29", spec)).ok).toBe(false);
		expect(validateDate(components("2000-02-29", spec)).ok).toBe(true);
		expect(validateDate(components("2100-02-29", spec)).ok).toBe(false);
	});
	it("parseEpoch returns null for invalid dates", () => {
		expect(parseEpoch("2026-13-01", spec)).toBeNull();
		expect(parseEpoch("2026-03-04", spec)).toBe(ymdToEpoch(2026, 3, 4));
	});
});

describe("formatEpoch", () => {
	const dateEpoch = ymdToEpoch(2026, 3, 4);
	it("formats date directives", () => {
		expect(formatEpoch(dateEpoch, "%Y-%m-%d")).toBe("2026-03-04");
		expect(formatEpoch(dateEpoch, "%m/%d/%Y")).toBe("03/04/2026");
		expect(formatEpoch(dateEpoch, "%F")).toBe("2026-03-04");
	});
	it("formats time directives", () => {
		const t = new Date(2026, 2, 4, 13, 5, 0, 0).getTime();
		expect(formatEpoch(t, "%H:%M")).toBe("13:05");
		expect(formatEpoch(t, "%R")).toBe("13:05");
		expect(formatEpoch(t, "%I:%M %p")).toBe("01:05 PM");
		expect(formatEpoch(new Date(2026, 2, 4, 0, 0).getTime(), "%I:%M %p")).toBe("12:00 AM");
	});
	it("passes through %% and unknown directives", () => {
		expect(formatEpoch(dateEpoch, "100%% done")).toBe("100% done");
		expect(formatEpoch(dateEpoch, "%Q")).toBe("%Q");
	});
});
