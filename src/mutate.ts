// mutate.ts — file-text mutation primitives. Port of taskbuffer.nvim's
// mutate.lua (port of go/mutate.go). PURE whole-file string transforms: take the
// file content, return new content. The Obsidian layer applies them atomically
// via Vault.process so two plugins never race.
//
// Newline fidelity: split/join on "\n" exactly like Go's strings.Split/Join.
// A file without a trailing newline stays without one; CRLF "\r" is preserved
// verbatim (we only ever TrimRight " \t", never "\r").

import { compile } from "./parse/strftime";

export class MutateError extends Error {}

function trimRightWs(line: string): string {
	return line.replace(/[ \t]+$/, "");
}

function regexEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkRange(lnum: number, n: number): void {
	if (lnum < 1 || lnum > n) throw new MutateError(`line ${lnum} out of range (file has ${n} lines)`);
}

/** Trim trailing whitespace of the target line, then append " " + text. */
export function appendToLine(content: string, lnum: number, text: string): string {
	const lines = content.split("\n");
	checkRange(lnum, lines.length);
	lines[lnum - 1] = trimRightWs(lines[lnum - 1] as string) + " " + text;
	return lines.join("\n");
}

/** Replace the FIRST literal occurrence of `from` with `to` on the line. */
export function changeCheckbox(content: string, lnum: number, from: string, to: string): string {
	if (from === "") throw new MutateError("changeCheckbox: empty 'from' checkbox string");
	if (to === "") throw new MutateError("changeCheckbox: empty 'to' checkbox string");
	const lines = content.split("\n");
	checkRange(lnum, lines.length);
	const line = lines[lnum - 1] as string;
	const i = line.indexOf(from);
	if (i !== -1) lines[lnum - 1] = line.slice(0, i) + to + line.slice(i + from.length);
	return lines.join("\n");
}

/**
 * Remove the LAST occurrence of `<markerPrefix><kind> [[DATE]] [TIME]` from the
 * line (time optional). No-op if absent. The base pattern requires the prefix
 * directly, so an inline due `(@[[...]])` is never matched.
 */
export function removeLastMarker(
	content: string,
	lnum: number,
	kind: string,
	dateFmt: string,
	timeFmt: string,
	markerPrefix: string,
): string {
	const lines = content.split("\n");
	checkRange(lnum, lines.length);
	const dateRun = compile(dateFmt).run;
	const timeRun = compile(timeFmt).run;
	let line = lines[lnum - 1] as string;

	const baseRe = new RegExp("\\s*" + regexEscape(markerPrefix) + regexEscape(kind) + "\\s+\\[\\[" + dateRun + "\\]\\]", "g");
	const timeRe = new RegExp("^" + timeRun);
	let lastStart = -1;
	let lastEnd = -1;
	let m: RegExpExecArray | null;
	while ((m = baseRe.exec(line)) !== null) {
		const s = m.index;
		let e = m.index + m[0].length;
		// Consume \s* after ]], then an optional TIME.
		const ws = /^\s*/.exec(line.slice(e));
		if (ws) e += ws[0].length;
		const tm = timeRe.exec(line.slice(e));
		if (tm) e += tm[0].length;
		lastStart = s;
		lastEnd = e;
		baseRe.lastIndex = e > m.index ? e : m.index + 1;
	}
	if (lastStart === -1) return content; // nothing to remove
	line = trimRightWs(line.slice(0, lastStart) + line.slice(lastEnd));
	lines[lnum - 1] = line;
	return lines.join("\n");
}

/**
 * Insert `text` on the line after a header (trimmed equality). `content === null`
 * means the file does not exist → create it with header + text. Header missing →
 * append header + text at the end.
 */
export function insertAfterHeader(content: string | null, header: string, text: string): string {
	if (content === null) return header + "\n" + text + "\n";
	const lines = content.split("\n");
	const target = header.trim();
	const headerIdx = lines.findIndex((l) => l.trim() === target);
	if (headerIdx === -1) {
		let c = content;
		if (!c.endsWith("\n")) c += "\n";
		return c + "\n" + header + "\n" + text + "\n";
	}
	lines.splice(headerIdx + 1, 0, text);
	return lines.join("\n");
}

/** Replace line `lnum` (1-based) with `newLine`. */
export function setLine(content: string, lnum: number, newLine: string): string {
	const lines = content.split("\n");
	checkRange(lnum, lines.length);
	lines[lnum - 1] = newLine;
	return lines.join("\n");
}

/** Append `text` + "\n". `content === null` means create the file. */
export function appendToFile(content: string | null, text: string): string {
	if (content === null) return text + "\n";
	let c = content;
	if (!c.endsWith("\n")) c += "\n";
	return c + text + "\n";
}
