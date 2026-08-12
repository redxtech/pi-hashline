import { describe, expect, it } from "vitest";
import {
	computeFileHash,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	parsePatch,
} from "../src/hashline";

const PATH = "src/old.ts";
const DEST = "src/new.ts";
const CONTENT = "one\ntwo\nthree\n";

class FailingMoveFilesystem extends InMemoryFilesystem {
	override async move(): Promise<void> {
		throw new Error("simulated move failure");
	}
}

describe("hashline file ops", () => {
	it("parses REM and rejects line ops in the same section", () => {
		expect(parsePatch("REM").fileOp).toEqual({ kind: "rem" });
		expect(() => parsePatch(`PUT 1-1:\n+one\nREM`)).toThrow(/REM.*line ops/);
	});

	it("parses MV with a normalized destination path", () => {
		const section = Patch.parseSingle(`[${PATH}#AB12]\nMV ${DEST}`);
		expect(section.fileOp).toEqual({ kind: "move", dest: DEST });
	});

	it("deletes a tagged file with REM", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nREM`));

		expect(result.sections[0]?.op).toBe("delete");
		expect(fs.get(PATH)).toBeUndefined();
		expect(snapshots.byHash(PATH, tag)).toBeNull();
	});

	it("moves a file without content edits", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nMV ${DEST}`));

		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[0]?.moveDest).toBe(DEST);
		expect(fs.get(PATH)).toBeUndefined();
		expect(fs.get(DEST)).toBe(CONTENT);
		expect(snapshots.byHash(DEST, tag)?.text).toBe(CONTENT);
		expect(snapshots.byHash(DEST, tag)?.seenLines).toEqual(new Set([1, 2]));
		expect(snapshots.byHash(PATH, tag)).toBeNull();
	});

	it("refuses to overwrite an existing move destination", async () => {
		const fs = new InMemoryFilesystem([
			[PATH, CONTENT],
			[DEST, "unrelated\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nMV ${DEST}`))).rejects.toThrow(
			/MV destination already exists/,
		);
		expect(fs.get(PATH)).toBe(CONTENT);
		expect(fs.get(DEST)).toBe("unrelated\n");
	});

	it("rejects batches whose moves share a destination", async () => {
		const secondPath = "src/other.ts";
		const fs = new InMemoryFilesystem([
			[PATH, CONTENT],
			[secondPath, "other\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const firstTag = snapshots.record(PATH, CONTENT);
		const secondTag = snapshots.record(secondPath, "other\n");
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(
			`[${PATH}#${firstTag}]\nMV ${DEST}\n[${secondPath}#${secondTag}]\nMV ${DEST}`,
		))).rejects.toThrow(/Multiple hashline operations resolve to the same file/);
		expect(fs.get(PATH)).toBe(CONTENT);
		expect(fs.get(secondPath)).toBe("other\n");
		expect(fs.get(DEST)).toBeUndefined();
	});

	it("keeps source snapshot history when a move fails", async () => {
		const fs = new FailingMoveFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nMV ${DEST}`))).rejects.toThrow(
			"simulated move failure",
		);

		expect(fs.get(PATH)).toBe(CONTENT);
		expect(fs.get(DEST)).toBeUndefined();
		expect(snapshots.byHash(PATH, tag)?.seenLines).toEqual(new Set([1, 2]));
		expect(snapshots.byHash(DEST, tag)).toBeNull();
	});

	it("applies line edits then moves the updated content", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2-2:\n+TWO\nMV ${DEST}`));

		expect(result.sections[0]?.moveDest).toBe(DEST);
		expect(fs.get(PATH)).toBeUndefined();
		expect(fs.get(DEST)).toBe("one\nTWO\nthree\n");
		expect(result.sections[0]?.fileHash).toBe(computeFileHash("one\nTWO\nthree\n"));
		expect(snapshots.head(DEST)?.hash).toBe(result.sections[0]?.fileHash);
	});
});
