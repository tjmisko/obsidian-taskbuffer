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
