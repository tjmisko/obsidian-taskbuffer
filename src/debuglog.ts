// debuglog.ts — capture console output and uncaught errors into a bounded
// ring buffer so logs can be pulled off a device. Exists for mobile debugging:
// Obsidian on iOS has no devtools, so the only way to read a stack trace is to
// carry it out through the clipboard or a note. Pure module (no "obsidian"
// import) so it is unit-tested directly under Node.

export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface LogEntry {
	epochMs: number;
	level: LogLevel;
	text: string;
}

const LOG_LEVELS: LogLevel[] = ["log", "info", "warn", "error", "debug"];
const MAX_ARG_LENGTH = 2000;
export const DEFAULT_CAPACITY = 2000;

/** Bounded FIFO of formatted log entries; the oldest entries drop off first. */
export class LogBuffer {
	private entries: LogEntry[] = [];

	constructor(
		private readonly capacity: number = DEFAULT_CAPACITY,
		private readonly now: () => number = () => Date.now(),
	) {}

	push(level: LogLevel, args: unknown[]): void {
		const text = args.map(formatLogArg).join(" ");
		this.entries.push({ epochMs: this.now(), level, text });
		if (this.entries.length > this.capacity) this.entries.shift();
	}

	get length(): number {
		return this.entries.length;
	}

	/** All captured entries as display lines, oldest first. */
	lines(): string[] {
		return this.entries.map((e) => `${new Date(e.epochMs).toISOString()} [${e.level}] ${e.text}`);
	}

	clear(): void {
		this.entries = [];
	}
}

export function formatLogArg(value: unknown): string {
	if (typeof value === "string") return truncate(value);
	if (value instanceof Error) return truncate(value.stack ?? `${value.name}: ${value.message}`);
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint" ||
		typeof value === "symbol"
	) {
		return value.toString();
	}
	if (typeof value === "function") return "[function]";
	try {
		return truncate(JSON.stringify(value, circularReplacer()) ?? "[unserializable]");
	} catch {
		return "[unserializable]";
	}
}

function truncate(s: string): string {
	return s.length > MAX_ARG_LENGTH ? `${s.slice(0, MAX_ARG_LENGTH)}… (truncated)` : s;
}

function circularReplacer(): (key: string, value: unknown) => unknown {
	const seen = new WeakSet<object>();
	return (_key, value) => {
		if (typeof value === "object" && value !== null) {
			if (seen.has(value)) return "[circular]";
			seen.add(value);
		}
		return value;
	};
}

type LogFn = (...args: unknown[]) => void;

/** Minimal shape of `window` that ConsoleCapture needs, injectable for tests. */
export interface ErrorEventSource {
	addEventListener(type: string, listener: (evt: unknown) => void): void;
	removeEventListener(type: string, listener: (evt: unknown) => void): void;
}

/**
 * Patches the console methods to tee into a LogBuffer (original behavior is
 * preserved) and records `error` / `unhandledrejection` events. Captures the
 * whole app, not just this plugin — that is the point: on a phone this buffer
 * is the only console there is.
 */
export class ConsoleCapture {
	private readonly originals = new Map<LogLevel, LogFn>();
	private readonly patched = new Map<LogLevel, LogFn>();

	constructor(
		private readonly buffer: LogBuffer,
		private readonly con: Record<LogLevel, LogFn>,
		private readonly errorSource?: ErrorEventSource,
	) {}

	private readonly onErrorEvent = (evt: unknown): void => {
		const e = evt as { error?: unknown; message?: unknown };
		this.buffer.push("error", ["[uncaught]", e.error ?? e.message ?? evt]);
	};

	private readonly onRejectionEvent = (evt: unknown): void => {
		const e = evt as { reason?: unknown };
		this.buffer.push("error", ["[unhandled rejection]", e.reason]);
	};

	install(): void {
		for (const level of LOG_LEVELS) {
			const original = this.con[level];
			this.originals.set(level, original);
			const patchedFn: LogFn = (...args) => {
				this.buffer.push(level, args);
				original.apply(this.con, args);
			};
			this.patched.set(level, patchedFn);
			this.con[level] = patchedFn;
		}
		this.errorSource?.addEventListener("error", this.onErrorEvent);
		this.errorSource?.addEventListener("unhandledrejection", this.onRejectionEvent);
	}

	/** Restore each console method — unless something else patched over us since. */
	uninstall(): void {
		for (const level of LOG_LEVELS) {
			const original = this.originals.get(level);
			if (original && this.con[level] === this.patched.get(level)) this.con[level] = original;
		}
		this.originals.clear();
		this.patched.clear();
		this.errorSource?.removeEventListener("error", this.onErrorEvent);
		this.errorSource?.removeEventListener("unhandledrejection", this.onRejectionEvent);
	}
}

export interface DumpInfo {
	pluginVersion: string;
	platform: string;
	userAgent: string;
}

/** The full text handed to the clipboard / debug note. */
export function renderDump(buffer: LogBuffer, info: DumpInfo): string {
	const header = [
		`Taskbuffer debug log — plugin v${info.pluginVersion}`,
		`platform: ${info.platform}`,
		`user agent: ${info.userAgent}`,
		`entries: ${buffer.length}`,
	];
	return [...header, "", ...buffer.lines()].join("\n");
}
