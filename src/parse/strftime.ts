// strftime.ts — the date-format layer. Port of taskbuffer.nvim's strftime.lua
// (itself a port of go/timeformat.go). A strftime format string compiles into:
//   - `run`: a non-capturing regex source safe to embed inside a larger pattern
//   - `capture`: an anchored regex with one group per date/time directive
//   - `order`: which field each capture group holds
// Parsing extracts Y/m/d components and validates them strictly (JS Date would
// silently normalize 2026-13-45). Display reformats a local-noon epoch.
//
// Unlike the Lua port we have real regex (alternation, optional groups), so the
// directive fragments are plain character classes. Task due dates are local-noon
// epoch ms — build them only via ymdToEpoch AFTER validateDate passes.

import { isValidYMD, daysInMonth, ymdToEpoch } from "../dates";

export type DateField = "Y" | "m" | "d" | "H" | "M" | "I" | "p";

interface Directive {
	field: DateField;
	pat: string;
}

// Regex fragment for each modelled directive. None contain capture groups, so a
// compiled `run` can be wrapped in a single outer group without index drift.
const DIRECTIVE: Record<string, Directive> = {
	Y: { field: "Y", pat: "\\d\\d\\d\\d" },
	m: { field: "m", pat: "\\d\\d" },
	d: { field: "d", pat: "\\d\\d" },
	H: { field: "H", pat: "\\d\\d" },
	M: { field: "M", pat: "\\d\\d" },
	I: { field: "I", pat: "\\d\\d?" },
	p: { field: "p", pat: "[AaPp][Mm]" },
};

// Compound directives expand to a token sequence so component captures survive.
const COMPOUND: Record<string, string[]> = {
	F: ["Y", "-", "m", "-", "d"],
	R: ["H", ":", "M"],
};

type Token = { lit: string } | { field: DateField; pat: string } | { ws: true };

function regexEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(fmt: string): Token[] {
	const tokens: Token[] = [];
	const pushDirective = (letter: string): boolean => {
		const d = DIRECTIVE[letter];
		if (d) {
			tokens.push({ field: d.field, pat: d.pat });
			return true;
		}
		return false;
	};

	let i = 0;
	const n = fmt.length;
	while (i < n) {
		const c = fmt.charAt(i);
		if (c === "%" && i < n - 1) {
			const letter = fmt.charAt(i + 1);
			if (letter === "%") {
				tokens.push({ lit: "%" });
			} else if (COMPOUND[letter]) {
				for (const part of COMPOUND[letter]) {
					if (DIRECTIVE[part]) pushDirective(part);
					else tokens.push({ lit: part });
				}
			} else if (!pushDirective(letter)) {
				// Unknown directive: pass the two chars through literally.
				tokens.push({ lit: "%" + letter });
			}
			i += 2;
		} else {
			tokens.push({ lit: c });
			i += 1;
		}
	}
	return tokens;
}

export interface StrftimeSpec {
	run: string; // non-capturing regex source for embedding
	capture: RegExp; // anchored ^...$ with a group per directive
	order: DateField[];
	hasDate: boolean;
	fmt: string;
}

/** Compile a strftime format into regex material. Pure and cacheable. */
export function compile(fmt: string): StrftimeSpec {
	const tokens = tokenize(fmt || "");

	// Parity: a single space immediately before %p collapses into \s* so
	// "1:00 PM", "12:30PM", "1:00  AM" all match (timeformat.go:79-87).
	for (let idx = 0; idx < tokens.length; idx++) {
		const tok = tokens[idx];
		if (tok && "field" in tok && tok.field === "p") {
			const prev = tokens[idx - 1];
			if (prev && "lit" in prev && prev.lit.endsWith(" ")) {
				prev.lit = prev.lit.slice(0, -1);
				tokens.splice(idx, 0, { ws: true });
				break;
			}
		}
	}

	const runParts: string[] = [];
	const capParts: string[] = ["^"];
	const order: DateField[] = [];
	let hasDate = false;

	for (const tok of tokens) {
		if ("ws" in tok) {
			runParts.push("\\s*");
			capParts.push("\\s*");
		} else if ("field" in tok) {
			runParts.push(tok.pat);
			capParts.push("(" + tok.pat + ")");
			order.push(tok.field);
			if (tok.field === "Y" || tok.field === "m" || tok.field === "d") hasDate = true;
		} else {
			const frag = regexEscape(tok.lit);
			runParts.push(frag);
			capParts.push(frag);
		}
	}
	capParts.push("$");

	return {
		run: runParts.join(""),
		capture: new RegExp(capParts.join("")),
		order,
		hasDate,
		fmt,
	};
}

export interface YMDComponents {
	year: number;
	month: number;
	day: number;
}

/** Extract integer Y/m/d from a date string using a compiled spec, or null. */
export function components(dateStr: string, spec: StrftimeSpec): YMDComponents | null {
	if (!spec.hasDate) return null;
	const m = spec.capture.exec(dateStr);
	if (!m) return null;
	let year = NaN;
	let month = NaN;
	let day = NaN;
	for (let i = 0; i < spec.order.length; i++) {
		const field = spec.order[i];
		const v = Number(m[i + 1]);
		if (field === "Y") year = v;
		else if (field === "m") month = v;
		else if (field === "d") day = v;
	}
	return { year, month, day };
}

export interface ValidationResult {
	ok: boolean;
	reason?: string;
}

/** Strict calendar validation with a human reason (used for DateError display). */
export function validateDate(c: YMDComponents | null): ValidationResult {
	if (!c || !Number.isFinite(c.year) || !Number.isFinite(c.month) || !Number.isFinite(c.day)) {
		return { ok: false, reason: "non-numeric date component" };
	}
	if (c.month < 1 || c.month > 12) return { ok: false, reason: "month out of range" };
	if (c.day < 1 || c.day > daysInMonth(c.year, c.month)) return { ok: false, reason: "day out of range" };
	return { ok: true };
}

/** Parse a date string with a compiled spec into a local-noon epoch, or null. */
export function parseEpoch(dateStr: string, spec: StrftimeSpec): number | null {
	const c = components(dateStr, spec);
	if (!c || !validateDate(c).ok || !isValidYMD(c.year, c.month, c.day)) return null;
	return ymdToEpoch(c.year, c.month, c.day);
}

function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

function pad4(n: number): string {
	return String(n).padStart(4, "0");
}

/**
 * Format a local epoch through a strftime format. Supports the directives the
 * parser models (%Y %m %d %H %M %I %p %F %R %%); unknown directives pass through.
 * Used for the rendered date column and for writing marker timestamps.
 */
export function formatEpoch(epoch: number, fmt: string): string {
	const dt = new Date(epoch);
	const Y = pad4(dt.getFullYear());
	const m = pad2(dt.getMonth() + 1);
	const d = pad2(dt.getDate());
	const H = pad2(dt.getHours());
	const M = pad2(dt.getMinutes());
	const hour12 = ((dt.getHours() + 11) % 12) + 1;
	const I = pad2(hour12);
	const p = dt.getHours() < 12 ? "AM" : "PM";

	const expand = (letter: string): string => {
		switch (letter) {
			case "Y":
				return Y;
			case "m":
				return m;
			case "d":
				return d;
			case "H":
				return H;
			case "M":
				return M;
			case "I":
				return I;
			case "p":
				return p;
			case "F":
				return `${Y}-${m}-${d}`;
			case "R":
				return `${H}:${M}`;
			case "%":
				return "%";
			default:
				return "%" + letter;
		}
	};

	let out = "";
	for (let i = 0; i < fmt.length; i++) {
		const c = fmt.charAt(i);
		if (c === "%" && i < fmt.length - 1) {
			out += expand(fmt.charAt(i + 1));
			i += 1;
		} else {
			out += c;
		}
	}
	return out;
}
