import { describe, expect, it } from "vitest";
import { nativeBlockResolver } from "../src/extension";
import { parsesCleanly } from "../src/hashline/syntax";

describe("bounded parser caches", () => {
	it("checks text identity before reusing a colliding block range", () => {
		const first = "function f(){\n//023f91e9d53cf3\n}\n";
		const second = "function f(){\n//f563bcd99a864\n\n}\n";

		expect(nativeBlockResolver({ path: "collision.ts", text: first, line: 1 })).toEqual({ start: 1, end: 3 });
		expect(nativeBlockResolver({ path: "collision.ts", text: second, line: 1 })).toEqual({ start: 1, end: 4 });
	});

	it("checks text identity before reusing a colliding syntax verdict", () => {
		const valid = "const x = \"5f61728949dd\";\n";
		const invalid = "const x = \"5da0b9b9c0a9; \n";

		expect(parsesCleanly("collision.ts", valid)).toBe(true);
		expect(parsesCleanly("collision.ts", invalid)).toBe(false);
	});
});
