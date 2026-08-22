// Pure debounce-buffer semantics for metadata-driven incremental updates.

import type { FileContentSnapshot } from "./file-entry";

export interface FileChangeBatch {
	updates: FileContentSnapshot[];
	removals: string[];
}

/**
 * Coalesce changes by path. The last change before a drain wins, while drain()
 * swaps in fresh collections so arrivals during async batch processing belong
 * to the next batch.
 */
export class PendingFileChanges {
	private updates = new Map<string, FileContentSnapshot>();
	private removals = new Set<string>();

	queueUpdate(snapshot: FileContentSnapshot): void {
		this.removals.delete(snapshot.path);
		this.updates.set(snapshot.path, snapshot);
	}

	queueRemoval(path: string): void {
		this.updates.delete(path);
		this.removals.add(path);
	}

	hasPending(): boolean {
		return this.updates.size > 0 || this.removals.size > 0;
	}

	drain(): FileChangeBatch {
		const updates = this.updates;
		const removals = this.removals;
		this.updates = new Map();
		this.removals = new Set();
		return { updates: [...updates.values()], removals: [...removals] };
	}
}
