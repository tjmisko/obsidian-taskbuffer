import { describe, expect, it } from "vitest";

import { PendingFileChanges } from "../src/file-changes";
import type { FileContentSnapshot } from "../src/file-entry";

function snapshot(path: string, content: string): FileContentSnapshot {
	return { path, basename: path.replace(/\.md$/, ""), mtime: 1, size: content.length, content, frontmatter: null };
}

describe("PendingFileChanges", () => {
	it("drains only the latest snapshot for a path", () => {
		const pending = new PendingFileChanges();
		pending.queueUpdate(snapshot("tasks.md", "- [ ] old"));
		pending.queueUpdate(snapshot("tasks.md", "- [ ] latest"));

		const batch = pending.drain();
		expect(batch.removals).toEqual([]);
		expect(batch.updates).toHaveLength(1);
		expect(batch.updates[0]!.content).toBe("- [ ] latest");
		expect(pending.hasPending()).toBe(false);
	});

	it("lets removal beat an older update and a newer update re-add the path", () => {
		const pending = new PendingFileChanges();
		pending.queueUpdate(snapshot("tasks.md", "- [ ] old"));
		pending.queueRemoval("tasks.md");
		expect(pending.drain()).toEqual({ updates: [], removals: ["tasks.md"] });

		pending.queueRemoval("tasks.md");
		pending.queueUpdate(snapshot("tasks.md", "- [ ] recreated"));
		const readded = pending.drain();
		expect(readded.removals).toEqual([]);
		expect(readded.updates.map((item) => item.content)).toEqual(["- [ ] recreated"]);
	});

	it("keeps arrivals after a drain for the next batch", () => {
		const pending = new PendingFileChanges();
		pending.queueUpdate(snapshot("first.md", "- [ ] first"));
		const first = pending.drain();
		pending.queueUpdate(snapshot("second.md", "- [ ] second"));

		expect(first.updates.map((item) => item.path)).toEqual(["first.md"]);
		expect(pending.drain().updates.map((item) => item.path)).toEqual(["second.md"]);
	});
});
