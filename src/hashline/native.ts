import { createRequire } from "node:module";

export interface DiffRun {
	count: number;
	added: boolean;
	removed: boolean;
}

export interface BlockRange {
	startLine: number;
	endLine: number;
}

interface NativeBindings {
	diffLineRuns(oldText: string, newText: string): DiffRun[];
	enclosingBlockBoundaries(options: {
		code: string;
		path?: string;
		lang?: string;
		ranges: Array<{ startLine: number; endLine: number }>;
	}): number[] | null;
	blockRangeAt(options: { code: string; path?: string; lang?: string; line: number }): BlockRange | null;
}

const SUPPORTED_PLATFORM_PACKAGES: Record<string, string> = {
	"linux-x64": "@oh-my-pi/pi-natives-linux-x64",
	"linux-arm64": "@oh-my-pi/pi-natives-linux-arm64",
	"darwin-x64": "@oh-my-pi/pi-natives-darwin-x64",
	"darwin-arm64": "@oh-my-pi/pi-natives-darwin-arm64",
	"win32-x64": "@oh-my-pi/pi-natives-win32-x64",
};

function loadBindings(): NativeBindings {
	const platform = `${process.platform}-${process.arch}`;
	const packageName = SUPPORTED_PLATFORM_PACKAGES[platform];
	if (!packageName) {
		throw new Error(`Hashline native syntax support is unavailable on ${platform}.`);
	}

	try {
		const require = createRequire(import.meta.url);
		return require(packageName) as NativeBindings;
	} catch (error) {
		throw new Error(
			`Failed to load ${packageName}, required for exact hashline stale recovery and block operations. Reinstall pi-hashline on this platform.`,
			{ cause: error },
		);
	}
}

const bindings = loadBindings();

export const diffLineRuns = bindings.diffLineRuns;
export const enclosingBlockBoundaries = bindings.enclosingBlockBoundaries;
export const blockRangeAt = bindings.blockRangeAt;
