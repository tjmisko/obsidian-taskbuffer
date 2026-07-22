import { describe, expect, it, vi } from "vitest";
import { ConsoleCapture, LogBuffer, formatLogArg, renderDump } from "../src/debuglog";
import type { ErrorEventSource, LogLevel } from "../src/debuglog";

const fixedNow = (): number => 0;

function makeFakeConsole() {
	return {
		log: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

function makeFakeErrorSource() {
	const listeners = new Map<string, ((evt: unknown) => void)[]>();
	const source: ErrorEventSource = {
		addEventListener: (type, listener) => {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		removeEventListener: (type, listener) => {
			listeners.set(
				type,
				(listeners.get(type) ?? []).filter((l) => l !== listener),
			);
		},
	};
	const fire = (type: string, evt: unknown): void => {
		for (const l of listeners.get(type) ?? []) l(evt);
	};
	return { source, fire, listeners };
}

describe("LogBuffer", () => {
	it("should keep only the most recent entries when capacity is exceeded", () => {
		const buffer = new LogBuffer(3, fixedNow);
		for (const msg of ["m1", "m2", "m3", "m4", "m5"]) buffer.push("log", [msg]);
		expect(buffer.length).toBe(3);
		expect(buffer.lines().map((l) => l.slice(-2))).toEqual(["m3", "m4", "m5"]);
	});

	it("should join multiple arguments with spaces and tag the level", () => {
		const buffer = new LogBuffer(10, fixedNow);
		buffer.push("warn", ["scan took", 42, "ms"]);
		expect(buffer.lines()).toEqual(["1970-01-01T00:00:00.000Z [warn] scan took 42 ms"]);
	});

	it("should clear all entries when cleared", () => {
		const buffer = new LogBuffer(10, fixedNow);
		buffer.push("log", ["hello"]);
		buffer.clear();
		expect(buffer.length).toBe(0);
		expect(buffer.lines()).toEqual([]);
	});
});

describe("formatLogArg", () => {
	it("should format an Error argument with its stack", () => {
		const err = new Error("boom");
		expect(formatLogArg(err)).toContain("boom");
		expect(formatLogArg(err)).toContain("debuglog.test.ts");
	});

	it("should serialize plain objects to JSON", () => {
		expect(formatLogArg({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
	});

	it("should mark circular references instead of throwing", () => {
		const obj: Record<string, unknown> = { name: "loop" };
		obj.self = obj;
		expect(formatLogArg(obj)).toContain("[circular]");
	});

	it("should truncate arguments longer than the cap", () => {
		const formatted = formatLogArg("x".repeat(5000));
		expect(formatted).toContain("(truncated)");
		expect(formatted.length).toBeLessThan(2100);
	});

	it("should render undefined and null literally", () => {
		expect(formatLogArg(undefined)).toBe("undefined");
		expect(formatLogArg(null)).toBe("null");
	});
});

describe("ConsoleCapture", () => {
	it("should capture console calls while installed and still invoke the original", () => {
		const buffer = new LogBuffer(10, fixedNow);
		const con = makeFakeConsole();
		const original = con.warn;
		new ConsoleCapture(buffer, con).install();

		con.warn("low disk");

		expect(buffer.lines()).toEqual(["1970-01-01T00:00:00.000Z [warn] low disk"]);
		expect(original).toHaveBeenCalledWith("low disk");
	});

	it("should restore the original console methods when uninstalled", () => {
		const buffer = new LogBuffer(10, fixedNow);
		const con = makeFakeConsole();
		const originals = { ...con };
		const capture = new ConsoleCapture(buffer, con);
		capture.install();
		capture.uninstall();

		for (const level of ["log", "info", "warn", "error", "debug"] as LogLevel[]) {
			expect(con[level]).toBe(originals[level]);
		}
	});

	it("should leave a foreign patch in place when uninstalled", () => {
		const buffer = new LogBuffer(10, fixedNow);
		const con = makeFakeConsole();
		const capture = new ConsoleCapture(buffer, con);
		capture.install();
		const foreign = vi.fn();
		con.error = foreign;
		capture.uninstall();

		expect(con.error).toBe(foreign);
	});

	it("should record uncaught error events", () => {
		const buffer = new LogBuffer(10, fixedNow);
		const { source, fire } = makeFakeErrorSource();
		new ConsoleCapture(buffer, makeFakeConsole(), source).install();

		fire("error", { message: "kaboom", error: new Error("kaboom") });

		expect(buffer.lines()[0]).toContain("[uncaught]");
		expect(buffer.lines()[0]).toContain("kaboom");
	});

	it("should record unhandled promise rejections", () => {
		const buffer = new LogBuffer(10, fixedNow);
		const { source, fire } = makeFakeErrorSource();
		new ConsoleCapture(buffer, makeFakeConsole(), source).install();

		fire("unhandledrejection", { reason: "nope" });

		expect(buffer.lines()[0]).toContain("[unhandled rejection]");
		expect(buffer.lines()[0]).toContain("nope");
	});

	it("should stop listening for error events when uninstalled", () => {
		const buffer = new LogBuffer(10, fixedNow);
		const { source, fire, listeners } = makeFakeErrorSource();
		const capture = new ConsoleCapture(buffer, makeFakeConsole(), source);
		capture.install();
		capture.uninstall();

		fire("error", { message: "late" });

		expect(buffer.length).toBe(0);
		expect(listeners.get("error")).toEqual([]);
		expect(listeners.get("unhandledrejection")).toEqual([]);
	});
});

describe("renderDump", () => {
	it("should include the platform header followed by all entries", () => {
		const buffer = new LogBuffer(10, fixedNow);
		buffer.push("log", ["first"]);
		buffer.push("error", ["second"]);

		const dump = renderDump(buffer, { pluginVersion: "0.1.0", platform: "ios", userAgent: "test-agent" });

		expect(dump).toContain("plugin v0.1.0");
		expect(dump).toContain("platform: ios");
		expect(dump).toContain("entries: 2");
		expect(dump.endsWith("[log] first\n1970-01-01T00:00:00.000Z [error] second")).toBe(true);
	});
});
