// actions.ts — the verb layer. Port of go/main.go's cmd* handlers and
// taskbuffer.nvim's actions.lua. PURE composition over mutate.ts primitives +
// the marker formatter: each verb takes file content and returns new content.
// The ORDER of operations is byte-exact to the reference (cited inline). The
// timer verbs (start/stop/complete) and create — which touch the state store or
// other files — live in the Obsidian layer (TaskStore) on top of these.

import { ParseContext, extractInlineDueDate } from "./parse/parse";
import { formatMarker } from "./state";
import * as mutate from "./mutate";

function lineAt(content: string, lnum: number): string {
	const lines = content.split("\n");
	if (lnum < 1 || lnum > lines.length) {
		throw new mutate.MutateError(`line ${lnum} out of range (file has ${lines.length} lines)`);
	}
	return lines[lnum - 1] as string;
}

/** complete-at (cmdCompleteAt): append ::complete FIRST, then flip open -> done. */
export function completeAt(content: string, lnum: number, ctx: ParseContext, nowEpoch: number): string {
	const marker = formatMarker("complete", nowEpoch, ctx);
	const withMarker = mutate.appendToLine(content, lnum, marker);
	return mutate.changeCheckbox(withMarker, lnum, ctx.checkbox.open, ctx.checkbox.done);
}

/**
 * defer (cmdDefer): if there is no ::original marker, copy the inline due date
 * into `::original [[DATE]]` (date only, NO time/trailing space), then append the
 * ::deferral marker. The due date itself is NOT changed.
 */
export function defer(content: string, lnum: number, ctx: ParseContext, nowEpoch: number): string {
	const line = lineAt(content, lnum);
	const prefix = ctx.markerPrefix;
	let c = content;
	if (!line.includes(prefix + "original")) {
		const date = extractInlineDueDate(line, ctx);
		if (date) c = mutate.appendToLine(c, lnum, prefix + "original [[" + date + "]]");
	}
	const marker = formatMarker("deferral", nowEpoch, ctx);
	return mutate.appendToLine(c, lnum, marker);
}

/** check (cmdCheck): quick check-off, no marker. Flip open -> done. */
export function check(content: string, lnum: number, ctx: ParseContext): string {
	return mutate.changeCheckbox(content, lnum, ctx.checkbox.open, ctx.checkbox.done);
}

/** irrelevant (cmdIrrelevant): flip open -> irrelevant FIRST, then append ::irrelevant. */
export function irrelevant(content: string, lnum: number, ctx: ParseContext, nowEpoch: number): string {
	const flipped = mutate.changeCheckbox(content, lnum, ctx.checkbox.open, ctx.checkbox.irrelevant);
	const marker = formatMarker("irrelevant", nowEpoch, ctx);
	return mutate.appendToLine(flipped, lnum, marker);
}

/**
 * unset (cmdUnset): undo an irrelevant marking. Remove the LAST ::irrelevant
 * marker and restore irrelevant -> open. No-op if no such marker is present.
 */
export function unset(content: string, lnum: number, ctx: ParseContext): string {
	const line = lineAt(content, lnum);
	if (!line.includes(ctx.markerPrefix + "irrelevant")) return content; // no-op
	const removed = mutate.removeLastMarker(content, lnum, "irrelevant", ctx.dateFmt, ctx.timeFmt, ctx.markerPrefix);
	return mutate.changeCheckbox(removed, lnum, ctx.checkbox.irrelevant, ctx.checkbox.open);
}

/** Build the open-status task line for `create`. */
export function newTaskLine(body: string, ctx: ParseContext): string {
	return ctx.checkbox.open + " " + body;
}
