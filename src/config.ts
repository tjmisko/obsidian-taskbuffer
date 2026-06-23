// Plugin configuration. Mirrors taskbuffer.nvim's `config.lua`, adapted to
// Obsidian: paths are vault-relative, the timer/current-task state lives in
// plugin data (not the filesystem), and Neovim keymaps become Obsidian commands.
// The dead `formats.duration` knob from the reference is intentionally dropped —
// duration parsing is hardcoded to `<Nm>` there and here.

export interface CheckboxConfig {
	open: string;
	done: string;
	irrelevant: string;
}

export interface FormatsConfig {
	date: string; // strftime, used for both parse and display
	time: string; // strftime
	tagPrefix: string;
	checkbox: CheckboxConfig;
	/** 3-element `[open, mid, close]` (time between mid/close) or 2-element `[open, close]`. */
	dateWrapper: string[];
	markerPrefix: string;
}

export interface StatusConfig {
	key: string; // frontmatter key holding a file's status
	doneValues: string[]; // case-insensitive
}

export interface FrontmatterConfig {
	dueKey: string;
	inheritDue: boolean;
	requireTags: string[]; // inherit due only if the file's FM tags include ALL of these
	status: StatusConfig;
}

/** Day offset (0 = today), duration string ("2d"/"1w"/"1m"/"1y"), or calendar keyword. */
export type HorizonAfter = number | string;

export interface HorizonSpec {
	label: string;
	after?: HorizonAfter;
	undated?: boolean;
	order?: number;
}

export type OverlapMode = "sorted" | "first_match" | "narrowest";

export type WeekStart =
	| "monday"
	| "tuesday"
	| "wednesday"
	| "thursday"
	| "friday"
	| "saturday"
	| "sunday";

export interface InboxConfig {
	file: string; // vault-relative path for the `create` action
	header: string | null; // optional header to insert under
}

export interface TaskbufferSettings {
	/** Vault-relative folder paths (recursive) or globs. Empty array = entire vault. */
	sources: string[];
	inbox: InboxConfig;
	showUndated: boolean;
	strict: boolean;
	/** Log scan/render phase timings to the console (for diagnosing latency). */
	debugTiming: boolean;
	/** `null` = built-in {@link DEFAULT_HORIZONS}. */
	horizons: HorizonSpec[] | null;
	horizonsOverlap: OverlapMode;
	weekStart: WeekStart;
	frontmatter: FrontmatterConfig;
	formats: FormatsConfig;
}

export const DEFAULT_HORIZONS: HorizonSpec[] = [
	{ label: "Overdue", after: "past" },
	{ label: "Today", after: 0 },
	{ label: "Tomorrow", after: 1 },
	{ label: "This Week", after: 2 },
	{ label: "This Month", after: 8 },
	{ label: "This Year", after: "31d" },
	{ label: "Far Off", after: "366d" },
	{ label: "Someday", undated: true },
];

export const DEFAULT_SETTINGS: TaskbufferSettings = {
	sources: [],
	inbox: { file: "inbox.md", header: null },
	showUndated: true,
	strict: false,
	debugTiming: true,
	horizons: null,
	horizonsOverlap: "sorted",
	weekStart: "monday",
	frontmatter: {
		dueKey: "due",
		inheritDue: true,
		requireTags: [],
		status: { key: "status", doneValues: ["done", "complete"] },
	},
	formats: {
		date: "%Y-%m-%d",
		time: "%H:%M",
		tagPrefix: "#",
		checkbox: { open: "- [ ]", done: "- [x]", irrelevant: "- [-]" },
		dateWrapper: ["(@[[", "]]", ")"],
		markerPrefix: "::",
	},
};

/** The horizons actually in effect (user override or built-in defaults). */
export function effectiveHorizons(settings: TaskbufferSettings): HorizonSpec[] {
	return settings.horizons ?? DEFAULT_HORIZONS;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: Record<string, unknown>): T {
	const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
	for (const key of Object.keys(override)) {
		const next = override[key];
		if (next === undefined) continue; // missing keys keep the default
		const prev = out[key];
		// Recurse into nested objects; arrays and scalars (including false/null) replace wholesale.
		out[key] = isPlainObject(prev) && isPlainObject(next) ? deepMerge(prev, next) : next;
	}
	return out as T;
}

/**
 * Merge persisted data over defaults. Deep-merges nested objects but preserves
 * falsey user values (e.g. `false`, `""`, `[]`) and replaces arrays wholesale.
 */
export function mergeSettings(saved: unknown): TaskbufferSettings {
	const defaults = structuredClone(DEFAULT_SETTINGS);
	if (!isPlainObject(saved)) return defaults;
	return deepMerge(defaults, saved);
}

// ── settings hash (snapshot invalidation) ─────────────────────────────────────

/** Serialize a value with object keys sorted recursively, so it is stable. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
	const obj = value as Record<string, unknown>;
	return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** FNV-1a 32-bit hash → 8-char hex string. */
function hash32(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable hash over the PARSE-AFFECTING settings only (sources, horizons,
 * overlap, week start, strict, formats, frontmatter). When it differs from a
 * persisted snapshot's hash, that snapshot was produced under different parsing
 * rules and must be discarded so a full reconcile rebuilds it. Render-only knobs
 * (inbox, showUndated, debugTiming) are deliberately excluded — they don't
 * change which tasks exist or how they parse.
 */
export function settingsHash(settings: TaskbufferSettings): string {
	return hash32(
		stableStringify({
			sources: settings.sources,
			horizons: settings.horizons,
			horizonsOverlap: settings.horizonsOverlap,
			weekStart: settings.weekStart,
			strict: settings.strict,
			formats: settings.formats,
			frontmatter: settings.frontmatter,
		}),
	);
}
