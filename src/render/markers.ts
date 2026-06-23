// markers.ts — turn a task's raw state markers (::original, ::deferral, ::start,
// …) into a human-readable log. Markers keep their date/time strings verbatim as
// written, so we display them directly and only translate the `kind` into a
// glyph + label. Pure module — no Obsidian imports.

import { Marker } from "../types";

export interface LogEntry {
	glyph: string;
	label: string;
	when: string; // "date time" (either may be empty), trimmed
	kind: string; // raw kind, for CSS hooks
}

interface KindStyle {
	glyph: string;
	label: string;
}

// Known marker kinds, in the verbs that emit them (see actions.ts / state.ts).
const KIND_STYLES: Record<string, KindStyle> = {
	original: { glyph: "⟲", label: "originally due" },
	deferral: { glyph: "→", label: "deferred" },
	start: { glyph: "▶", label: "started" },
	stop: { glyph: "■", label: "stopped" },
	complete: { glyph: "✓", label: "completed" },
	irrelevant: { glyph: "∅", label: "dropped" },
};

function styleFor(kind: string): KindStyle {
	return KIND_STYLES[kind] ?? { glyph: "·", label: kind };
}

/** Build the ordered, human-readable log for one task's markers. */
export function describeMarkers(markers: Marker[]): LogEntry[] {
	const out: LogEntry[] = [];
	// Summarize repeated deferrals as a single "deferred ×N" entry at the position
	// of the LAST deferral, so a much-deferred task reads cleanly.
	const deferralCount = markers.filter((m) => m.kind === "deferral").length;
	let deferralsEmitted = 0;

	for (const m of markers) {
		const style = styleFor(m.kind);
		const when = `${m.date}${m.time ? " " + m.time : ""}`.trim();

		if (m.kind === "deferral") {
			deferralsEmitted += 1;
			if (deferralsEmitted < deferralCount) continue; // collapse into the last one
			const label = deferralCount > 1 ? `deferred ×${deferralCount}` : "deferred";
			out.push({ glyph: style.glyph, label, when, kind: m.kind });
			continue;
		}

		out.push({ glyph: style.glyph, label: style.label, when, kind: m.kind });
	}
	return out;
}
