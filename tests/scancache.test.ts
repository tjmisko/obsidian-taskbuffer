import { describe, it, expect } from "vitest";

import { validateScanCache, SCAN_CACHE_VERSION, type PersistedScanCache } from "../src/scancache";
import type { FileEntry } from "../src/scan";
import type { Task } from "../src/types";

const HASH = "abcd1234";

function task(overrides: Partial<Task> & { body: string }): Task {
	return {
		filePath: "f.md",
		lineNumber: 1,
		dueDate: null,
		dueTime: "",
		duration: "",
		tags: [],
		status: "open",
		markers: [],
		sortLast: false,
		...overrides,
	};
}

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
	return {
		path: "notes/a.md",
		mtime: 1_700_000_000_000,
		size: 512,
		enriched: [task({ body: "do the thing" })],
		errors: [],
		...overrides,
	};
}

function cache(overrides: Partial<PersistedScanCache> = {}): PersistedScanCache {
	return { version: SCAN_CACHE_VERSION, settingsHash: HASH, entries: [entry()], ...overrides };
}

describe("validateScanCache", () => {
	it("should return the entries when the blob is well-formed", () => {
		const entries = [entry(), entry({ path: "notes/b.md", enriched: [], errors: [] })];
		expect(validateScanCache(cache({ entries }), HASH)).toEqual(entries);
	});

	it("should survive a JSON round-trip (structured-clone analog)", () => {
		const blob = JSON.parse(JSON.stringify(cache())) as unknown;
		expect(validateScanCache(blob, HASH)).toEqual([entry()]);
	});

	it("should return null when the settings hash differs", () => {
		expect(validateScanCache(cache(), "0000ffff")).toBeNull();
	});

	it("should return null when the version differs", () => {
		expect(validateScanCache(cache({ version: SCAN_CACHE_VERSION + 1 }), HASH)).toBeNull();
	});

	it.each([
		["null", null],
		["a string", "cache"],
		["a number", 42],
		["an array", [entry()]],
		["an empty object", {}],
	])("should return null when the blob is %s", (_label, blob) => {
		expect(validateScanCache(blob, HASH)).toBeNull();
	});

	it("should return null when entries is not an array", () => {
		expect(validateScanCache({ version: SCAN_CACHE_VERSION, settingsHash: HASH, entries: {} }, HASH)).toBeNull();
	});

	it.each([
		["path is missing", { path: undefined }],
		["mtime is not a number", { mtime: "yesterday" }],
		["size is missing", { size: undefined }],
		["enriched is not an array", { enriched: null }],
		["errors is not an array", { errors: undefined }],
	])("should return null when an entry's %s", (_label, bad) => {
		const entries = [entry(), { ...entry(), ...bad }];
		expect(validateScanCache(cache({ entries: entries as FileEntry[] }), HASH)).toBeNull();
	});

	it("should accept an empty entries list", () => {
		expect(validateScanCache(cache({ entries: [] }), HASH)).toEqual([]);
	});
});
