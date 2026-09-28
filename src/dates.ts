// Pure date arithmetic shared by the parser, horizon bucketing, and date-shift
// actions. A "task date" is represented as the epoch (ms) of LOCAL NOON on that
// calendar day. Noon dodges DST transitions, so adding/subtracting whole days
// never lands on a missing/duplicated wall-clock hour, and two task dates are
// directly comparable for sorting and bucketing.

export const DAY_MS = 86_400_000;

/** Epoch (ms) of local noon on the given calendar day. Month is 1-based. */
export function ymdToEpoch(year: number, month: number, day: number): number {
	return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

export interface YMD {
	year: number;
	month: number; // 1-based
	day: number;
}

export function epochToYMD(epoch: number): YMD {
	const dt = new Date(epoch);
	return { year: dt.getFullYear(), month: dt.getMonth() + 1, day: dt.getDate() };
}

/** Local noon today. Accepts an injectable `now` for deterministic tests. */
export function todayEpoch(now: Date = new Date()): number {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0).getTime();
}

/** Add `n` whole days (may be negative), re-normalizing to local noon. */
export function addDays(epoch: number, n: number): number {
	const dt = new Date(epoch);
	dt.setDate(dt.getDate() + n);
	dt.setHours(12, 0, 0, 0);
	return dt.getTime();
}

export function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(year: number, month: number): number {
	if (month < 1 || month > 12) return 0;
	if (month === 2 && isLeapYear(year)) return 29;
	return MONTH_LENGTHS[month - 1] as number;
}

/** Strict calendar validation: month 1-12, day within the month (leap-aware). */
export function isValidYMD(year: number, month: number, day: number): boolean {
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
	if (month < 1 || month > 12) return false;
	if (day < 1 || day > daysInMonth(year, month)) return false;
	return true;
}

/** Day of week for a task epoch: 0 = Sunday … 6 = Saturday. */
export function weekday(epoch: number): number {
	return new Date(epoch).getDay();
}

/** `YYYY-MM-DD` for a task epoch — the wire format of `<input type="date">`. */
export function epochToIsoDate(epoch: number): string {
	const { year, month, day } = epochToYMD(epoch);
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Task epoch for an `<input type="date">` value, or null when it is empty (the
 * picker's Clear button) or not a real calendar date.
 */
export function isoDateToEpoch(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return null;
	const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (!isValidYMD(year, month, day)) return null;
	return ymdToEpoch(year, month, day);
}
