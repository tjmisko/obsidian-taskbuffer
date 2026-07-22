// scancache.ts — the persisted per-file scan cache (Pillar D). Serializes the
// engine's per-file entries so a cold start reconciles by re-reading ONLY the
// candidates whose mtime/size changed since last session, instead of every
// candidate (632 bridge reads ≈ 9.6s on an iPhone; with the cache it's however
// many files actually changed, usually a handful).
//
// Storage is IndexedDB, not data.json: the blob is O(all tasks) — megabytes on
// a large vault — and data.json lives in the vault where obsidian-git/sync
// would churn on every rewrite (the same constraint that caps the Pillar-A
// snapshot, see snapshot.ts). IndexedDB is device-local, which is correct
// here: entries are validated against THIS device's vault file index, and a
// missing/cleared cache just degrades to the full candidate scan.
//
// Only `validateScanCache` is pure; the load/save helpers touch IndexedDB and
// swallow failures (a broken cache must never break the plugin).

import type { FileEntry } from "./scan";

export const SCAN_CACHE_VERSION = 1;

/** The blob stored in IndexedDB. */
export interface PersistedScanCache {
	version: number;
	settingsHash: string;
	entries: FileEntry[];
}

/**
 * Validate a raw blob read back from storage. Returns its entries, or null when
 * the blob is malformed, from a different cache version, or was produced under
 * different parse-affecting settings (settingsHash mismatch) — all of which
 * mean "do the full scan instead".
 */
export function validateScanCache(raw: unknown, settingsHash: string): FileEntry[] | null {
	if (typeof raw !== "object" || raw === null) return null;
	const cache = raw as Partial<PersistedScanCache>;
	if (cache.version !== SCAN_CACHE_VERSION) return null;
	if (cache.settingsHash !== settingsHash) return null;
	if (!Array.isArray(cache.entries)) return null;
	const entries: unknown[] = cache.entries;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) return null;
		const e = entry as Partial<FileEntry>;
		if (typeof e.path !== "string" || typeof e.mtime !== "number" || typeof e.size !== "number") return null;
		if (!Array.isArray(e.enriched) || !Array.isArray(e.errors)) return null;
	}
	return cache.entries;
}

/** Per-vault DB name (Obsidian shares one origin across vaults on desktop). */
export function scanCacheDbName(appId: string): string {
	return `taskbuffer/scan-cache/${appId}`;
}

const STORE_NAME = "scan";
const CACHE_KEY = "cache";

function openDb(dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(dbName, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
	});
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
	});
}

async function idbGet(dbName: string): Promise<unknown> {
	const db = await openDb(dbName);
	try {
		return await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(CACHE_KEY));
	} finally {
		db.close();
	}
}

async function idbPut(dbName: string, value: unknown): Promise<void> {
	const db = await openDb(dbName);
	try {
		await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(value, CACHE_KEY));
	} finally {
		db.close();
	}
}

/** Reject after `ms` so a wedged IndexedDB (a known iOS WebKit failure mode)
 * delays startup by at most the timeout instead of hanging the reconcile. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`indexedDB timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e: unknown) => {
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}

/** Load and validate the cache; null means "no usable cache — full scan". */
export async function loadScanCache(
	dbName: string,
	settingsHash: string,
	timeoutMs = 3000,
): Promise<FileEntry[] | null> {
	try {
		const raw = await withTimeout(idbGet(dbName), timeoutMs);
		if (raw === undefined) return null;
		return validateScanCache(raw, settingsHash);
	} catch (err) {
		console.warn("[taskbuffer] scan cache load failed", err);
		return null;
	}
}

/** Persist the cache; failures are logged and swallowed. */
export async function saveScanCache(dbName: string, settingsHash: string, entries: FileEntry[]): Promise<void> {
	const blob: PersistedScanCache = { version: SCAN_CACHE_VERSION, settingsHash, entries };
	try {
		await idbPut(dbName, blob);
	} catch (err) {
		console.warn("[taskbuffer] scan cache save failed", err);
	}
}
