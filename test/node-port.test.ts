import { describe, expect, it } from "vitest";
import { computeFileHash } from "../src/hashline";
import { blockRangeAt, diffLineRuns } from "../src/hashline/native";

/** Values captured from Bun.hash.xxHash32 in oh-my-pi v17.2.12. */
describe("Node port compatibility", () => {
	it.each([
		["", "5D05"],
		["hello", "77F9"],
		["alpha\nbeta\ngamma\n", "B6C1"],
		["😀\n", "B9DA"],
	])("matches OMP's whole-file tag for %j", (text, expected) => {
		expect(computeFileHash(text)).toBe(expected);
	});

	it("loads OMP's native line-diff and tree-sitter primitives under Node", () => {
		expect(diffLineRuns("a\nb\n", "x\na\nb\n")).toEqual([
			{ count: 1, added: true, removed: false },
			{ count: 3, added: false, removed: false },
		]);
		expect(blockRangeAt({
			code: "function greet() {\n  return 'hi';\n}\n",
			path: "greet.ts",
			line: 1,
		})).toEqual({ startLine: 1, endLine: 3 });
	});
});
