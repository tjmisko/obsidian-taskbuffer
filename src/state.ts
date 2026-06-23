// state.ts — the canonical marker formatter + current-task (timer) type.
// Port of go/state.go's FormatMarker + CurrentTask. The state STORAGE moves from
// a filesystem TSV to Obsidian plugin data (see TaskStore), so only the pure
// pieces live here.

import { formatEpoch } from "./parse/strftime";

/** The currently-running (timed) task. Stored in plugin data as JSON. */
export interface CurrentTask {
	startTime: number; // epoch ms when the timer started
	name: string; // task body (display only)
	filePath: string;
	lineNumber: number;
}

/** Minimal context the marker formatter needs. */
export interface MarkerContext {
	markerPrefix: string;
	dateFmt: string;
	timeFmt: string;
}

/**
 * Canonical marker formatter: `<prefix><kind> [[DATE]] TIME ` (note the TRAILING
 * space). The configured markerPrefix is honored (the Go impl hardcoded "::";
 * default "::" is byte-identical). `nowEpoch` is injected for deterministic tests.
 */
export function formatMarker(kind: string, nowEpoch: number, ctx: MarkerContext): string {
	const date = formatEpoch(nowEpoch, ctx.dateFmt);
	const time = formatEpoch(nowEpoch, ctx.timeFmt);
	return `${ctx.markerPrefix}${kind} [[${date}]] ${time} `;
}
