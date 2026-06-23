// snapshot.ts — the persisted task snapshot (Pillar A). A small, capped slice of
// the open task list, stored in data.json so the view can paint instantly on a
// cold start, BEFORE any vault scan runs. The background reconcile then fills in
// the rest. Pure module: it MUST NOT import "obsidian".

import type { Task } from "./types";

/**
 * Max OPEN UNDATED tasks kept in the snapshot. The near-horizon dated tasks are
 * what the user sees first; the large `Someday` tail is deferred to the
 * background reconcile, keeping the persisted blob small.
 */
export const SNAPSHOT_UNDATED_CAP = 200;

/** Versioned persisted snapshot shape, stored under `PersistedData.snapshot`. */
export interface PersistedSnapshot {
	version: 1;
	settingsHash: string;
	tasks: Task[];
}

/**
 * Trim a flat task list to the urgent slice worth persisting: ALL open dated
 * tasks plus the first `cap` open undated tasks (input order preserved).
 * done/irrelevant tasks are never persisted — the view never shows them.
 *
 * Capping keeps data.json to tens of KB, which matters because the vault is
 * typically under obsidian-git and a multi-MB cache would churn the repo.
 */
export function trimSnapshot(tasks: Task[], cap: number = SNAPSHOT_UNDATED_CAP): Task[] {
	const open = tasks.filter((t) => t.status === "open");
	const dated = open.filter((t) => t.dueDate !== null);
	const undated = open.filter((t) => t.dueDate === null).slice(0, cap);
	return [...dated, ...undated];
}
