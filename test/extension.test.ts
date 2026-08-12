import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import hashlineExtension from "../src/extension";
import { NodeFilesystem } from "../src/hashline";

type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), "pi-hashline-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function harness(cwd: string, sessionId: string) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const extensionApi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerTool(tool: RegisteredTool & { name: string }) {
			tools.set(tool.name, tool);
		},
	};
	hashlineExtension(extensionApi as never);
	const ctx = {
		cwd,
		model: undefined,
		sessionManager: { getSessionId: () => sessionId },
		ui: { setStatus() {}, notify() {} },
	};
	const execute = async (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing registered tool: ${name}`);
		return tool.execute("call", params, undefined, undefined, ctx);
	};
	return { execute, handlers, ctx };
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof harness>["execute"]>>): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function tagFrom(readOutput: string): string {
	const match = readOutput.match(/^\[[^#]+#([0-9A-F]+)\]/);
	if (!match?.[1]) throw new Error(`No snapshot tag in output: ${readOutput}`);
	return match[1];
}

describe("Pi extension integration", () => {
	it("reads, edits, and returns Pi-native diff details", async () => {
		const cwd = await temporaryDirectory();
		await fs.writeFile(path.join(cwd, "note.txt"), "one\ntwo\n");
		const { execute } = harness(cwd, "basic");

		const readResult = await execute("read", { path: "note.txt" });
		const readText = textOf(readResult);
		const tag = tagFrom(readText);
		expect(readText).toContain("1:one\n2:two\n3:");

		const editResult = await execute("edit", {
			input: `[note.txt#${tag}]\nPUT 2-2:\n+TWO`,
		});

		expect(await fs.readFile(path.join(cwd, "note.txt"), "utf8")).toBe("one\nTWO\n");
		expect(textOf(editResult)).toContain("-2 two");
		expect(editResult.details).toMatchObject({
			perFileResults: [{ path: "note.txt", op: "update", firstChangedLine: 2 }],
		});
	});

	it("enforces the exact displayed-line provenance, including the trailing blank row", async () => {
		const cwd = await temporaryDirectory();
		await fs.writeFile(path.join(cwd, "partial.txt"), "a\nb\nc\n");
		await fs.writeFile(path.join(cwd, "trailing.txt"), "a\nb\n");
		const { execute } = harness(cwd, "seen-lines");

		const partialTag = tagFrom(textOf(await execute("read", { path: "partial.txt", limit: 1 })));
		await expect(execute("edit", {
			input: `[partial.txt#${partialTag}]\nPUT 2-2:\n+B`,
		})).rejects.toThrow(/never displayed/);

		const trailingTag = tagFrom(textOf(await execute("read", { path: "trailing.txt" })));
		await execute("edit", { input: `[trailing.txt#${trailingTag}]\nPUT 3-3:\n+c` });
		expect(await fs.readFile(path.join(cwd, "trailing.txt"), "utf8")).toBe("a\nb\nc\n");
	});

	it("makes disk-adapter moves exclusive and preserves source modes", async () => {
		const cwd = await temporaryDirectory();
		const source = path.join(cwd, "node-source.txt");
		const destination = path.join(cwd, "node-destination.txt");
		await fs.writeFile(source, "source\n");
		await fs.chmod(source, 0o664);
		const filesystem = new NodeFilesystem();

		await filesystem.move(source, destination, "changed\n");
		expect(await fs.readFile(destination, "utf8")).toBe("changed\n");
		expect((await fs.stat(destination)).mode & 0o777).toBe(0o664);

		await fs.writeFile(source, "new source\n");
		await expect(filesystem.move(source, destination, "overwrite\n")).rejects.toMatchObject({ code: "EEXIST" });
		expect(await fs.readFile(source, "utf8")).toBe("new source\n");
		expect(await fs.readFile(destination, "utf8")).toBe("changed\n");
	});

	it("refuses to overwrite an existing move destination", async () => {
		const cwd = await temporaryDirectory();
		await fs.writeFile(path.join(cwd, "source.txt"), "source\n");
		await fs.writeFile(path.join(cwd, "destination.txt"), "destination\n");
		const { execute } = harness(cwd, "move-overwrite");
		const tag = tagFrom(textOf(await execute("read", { path: "source.txt" })));

		await expect(execute("edit", {
			input: `[source.txt#${tag}]\nMV destination.txt`,
		})).rejects.toThrow(/MV destination already exists/);
		expect(await fs.readFile(path.join(cwd, "source.txt"), "utf8")).toBe("source\n");
		expect(await fs.readFile(path.join(cwd, "destination.txt"), "utf8")).toBe("destination\n");
	});

	it("recovers stale anchors after external edits and preserves history through a symlinked move", async () => {
		const cwd = await temporaryDirectory();
		const real = path.join(cwd, "real");
		await fs.mkdir(real);
		await fs.symlink(real, path.join(cwd, "link"));
		await fs.writeFile(path.join(real, "old.txt"), "one\ntwo\n");
		await fs.chmod(path.join(real, "old.txt"), 0o664);
		const { execute } = harness(cwd, "recovery-move");

		const staleTag = tagFrom(textOf(await execute("read", { path: "link/old.txt" })));
		await fs.writeFile(path.join(real, "old.txt"), "inserted\none\ntwo\n");
		await execute("edit", { input: `[link/old.txt#${staleTag}]\nPUT 2-2:\n+TWO` });
		expect(await fs.readFile(path.join(real, "old.txt"), "utf8")).toBe("inserted\none\nTWO\n");

		const moveTag = tagFrom(textOf(await execute("read", { path: "link/old.txt" })));
		await execute("edit", {
			input: `[link/old.txt#${moveTag}]\nPUT 3-3:\n+THREE\nMV link/new.txt`,
		});
		expect(await fs.readFile(path.join(real, "new.txt"), "utf8")).toBe("inserted\none\nTHREE\n");
		expect((await fs.stat(path.join(real, "new.txt"))).mode & 0o777).toBe(0o664);

		await execute("edit", { input: `[link/new.txt#${moveTag}]\nPUT 2-2:\n+ONE` });
		expect(await fs.readFile(path.join(real, "new.txt"), "utf8")).toBe("inserted\nONE\nTHREE\n");
	});
});
