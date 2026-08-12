import XXH from "xxhashjs";

/** Exact unsigned xxHash32 used by Bun.hash.xxHash32. */
export function xxHash32(text: string, seed = 0): number {
	return XXH.h32(text, seed).toNumber() >>> 0;
}
