import { constants as fsConstants, readFileSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type AgentToolResult,
	createReadToolDefinition,
	formatSize,
	generateDiffString,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadToolDetails,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildCompactDiffPreview,
	type Clipboard,
	Filesystem,
	formatHashlineHeader,
	formatNumberedLines,
	InMemorySnapshotStore,
	isNotFound,
	moveFileExclusive,
	NotFoundError,
	normalizeToLF,
	Patch,
	Patcher,
	stripBom,
	type PatchSectionResult,
	type PreflightWriteOptions,
	type SnapshotStore,
	type WriteResult,
} from "./hashline";
import { xxHash32 } from "./hashline/hash";
import { blockRangeAt } from "./hashline/native";

const HASHLINE_PROMPT = readFileSync(fileURLToPath(new URL("./hashline/prompt.md", import.meta.url)), "utf8");
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_NAMED_REGISTERS = 64;
const MAX_NAMED_REGISTER_BYTES = 16 * 1024 * 1024;

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

const editSchema = Type.Object({
	input: Type.String({ description: "Hashline patch containing one or more [PATH#TAG] sections" }),
});

interface PerFileEditResult {
	path: string;
	op: PatchSectionResult["op"];
	diff: string;
	firstChangedLine?: number;
	fileHash: string;
}

interface HashlineEditDetails {
	diff: string;
	firstChangedLine?: number;
	perFileResults: PerFileEditResult[];
}

interface SessionState {
	snapshots: InMemorySnapshotStore;
	clipboard: Clipboard;
}

const runtimeGlobal = globalThis as typeof globalThis & {
	__piHashlineSessionStates?: Map<string, SessionState>;
};
const sessionStates = (runtimeGlobal.__piHashlineSessionStates ??= new Map());

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function getSessionState(ctx: ExtensionContext): SessionState {
	const key = sessionKey(ctx);
	let state = sessionStates.get(key);
	if (!state) {
		state = { snapshots: new InMemorySnapshotStore(), clipboard: { named: new Map() } };
		sessionStates.set(key, state);
	}
	return state;
}

/** Keep persistent cross-call registers bounded for long-lived Pi sessions. */
function pruneNamedRegisters(clipboard: Clipboard): void {
	const named = clipboard.named;
	if (!named) return;
	let totalBytes = 0;
	for (const lines of named.values()) totalBytes += Buffer.byteLength(lines.join("\n"), "utf8");
	while (named.size > MAX_NAMED_REGISTERS || totalBytes > MAX_NAMED_REGISTER_BYTES) {
		const oldest = named.entries().next().value;
		if (!oldest) break;
		const [name, lines] = oldest;
		totalBytes -= Buffer.byteLength(lines.join("\n"), "utf8");
		named.delete(name);
	}
}

function normalizeToolPath(rawPath: string): string {
	let value = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (value === "~") return homedir();
	if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
		value = path.join(homedir(), value.slice(2));
	}
	return value;
}

function resolveToolPath(rawPath: string, cwd: string): string {
	const normalized = normalizeToolPath(rawPath);
	return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(cwd, normalized);
}

function canonicalPathSync(rawPath: string, cwd: string): string {
	const absolute = resolveToolPath(rawPath, cwd);
	try {
		return realpathSync.native(absolute);
	} catch (error) {
		if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	// A move destination may not exist yet. Resolve the longest existing parent
	// so aliases through symlinked directories still share one queue/snapshot key.
	const suffix: string[] = [];
	let current = absolute;
	while (true) {
		suffix.unshift(path.basename(current));
		const parent = path.dirname(current);
		if (parent === current) return absolute;
		try {
			return path.join(realpathSync.native(parent), ...suffix);
		} catch (error) {
			if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			current = parent;
		}
	}
}

function displayPath(absolutePath: string, cwd: string): string {
	const relative = path.relative(cwd, absolutePath);
	if (relative === "") return path.basename(absolutePath);
	if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
	return absolutePath;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

class PiFilesystem extends Filesystem {
	constructor(
		readonly cwd: string,
		readonly signal: AbortSignal | undefined,
	) {
		super();
	}

	resolve(inputPath: string): string {
		return resolveToolPath(inputPath, this.cwd);
	}

	override canonicalPath(inputPath: string): string {
		return canonicalPathSync(inputPath, this.cwd);
	}

	override allowTagPathRecovery(_authoredPath: string, resolvedPath: string): boolean {
		const root = canonicalPathSync(this.cwd, this.cwd);
		const target = canonicalPathSync(resolvedPath, this.cwd);
		return target === root || target.startsWith(`${root}${path.sep}`);
	}

	async readText(inputPath: string): Promise<string> {
		assertNotAborted(this.signal);
		const absolutePath = this.resolve(inputPath);
		try {
			return await fs.readFile(absolutePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(inputPath, error);
			throw error;
		}
	}

	override async readBinary(inputPath: string): Promise<Uint8Array> {
		assertNotAborted(this.signal);
		try {
			return await fs.readFile(this.resolve(inputPath));
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(inputPath, error);
			throw error;
		}
	}

	override async preflightWrite(inputPath: string, options?: PreflightWriteOptions): Promise<void> {
		assertNotAborted(this.signal);
		const absolutePath = this.resolve(inputPath);
		const stat = await fs.stat(absolutePath).catch(error => {
			if (isNotFound(error)) throw new NotFoundError(inputPath, error);
			throw error;
		});
		if (!stat.isFile()) throw new Error(`Cannot edit non-file path: ${inputPath}`);
		await fs.access(absolutePath, fsConstants.R_OK | fsConstants.W_OK);

		if (options?.fileOp?.kind === "rem" || options?.fileOp?.kind === "move") {
			await fs.access(path.dirname(absolutePath), fsConstants.W_OK | fsConstants.X_OK);
		}
		if (options?.fileOp?.kind === "move") {
			const destination = this.resolve(options.fileOp.dest);
			const destinationParent = path.dirname(destination);
			const parentStat = await fs.stat(destinationParent);
			if (!parentStat.isDirectory()) {
				throw new Error(`MV destination parent is not a directory: ${destinationParent}`);
			}
			await fs.access(destinationParent, fsConstants.W_OK | fsConstants.X_OK);
			try {
				await fs.lstat(destination);
				throw new Error(`MV destination already exists: ${options.fileOp.dest}. Refusing to overwrite it.`);
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		}
	}

	async writeText(inputPath: string, content: string): Promise<WriteResult> {
		assertNotAborted(this.signal);
		const absolutePath = this.resolve(inputPath);
		await fs.writeFile(absolutePath, content, "utf8");
		return { text: await fs.readFile(absolutePath, "utf8") };
	}

	override async delete(inputPath: string): Promise<void> {
		assertNotAborted(this.signal);
		try {
			await fs.rm(this.resolve(inputPath));
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(inputPath, error);
			throw error;
		}
	}

	override async move(from: string, to: string, content?: string): Promise<void> {
		assertNotAborted(this.signal);
		await moveFileExclusive(this.resolve(from), this.resolve(to), content);
	}

	override async exists(inputPath: string): Promise<boolean> {
		try {
			await fs.access(this.resolve(inputPath));
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}
}

const blockResolutionCache = new Map<
	string,
	{ text: string; result: { start: number; end: number } | null }
>();
const BLOCK_RESOLUTION_CACHE_MAX = 512;

export function nativeBlockResolver({ path: filePath, text, line }: { path: string; text: string; line: number }) {
	const key = `${xxHash32(text).toString(36)}:${text.length}:${line}:${filePath}`;
	const cached = blockResolutionCache.get(key);
	if (cached?.text === text) return cached.result;
	const range = blockRangeAt({ code: text, path: filePath, line });
	const result = range ? { start: range.startLine, end: range.endLine } : null;
	if (blockResolutionCache.size >= BLOCK_RESOLUTION_CACHE_MAX) {
		const oldest = blockResolutionCache.keys().next().value;
		if (oldest !== undefined) blockResolutionCache.delete(oldest);
	}
	blockResolutionCache.set(key, { text, result });
	return result;
}

function appendHashlineUnavailableNotice(
	result: AgentToolResult<ReadToolDetails | undefined>,
	reason: string,
): AgentToolResult<ReadToolDetails | undefined> {
	return {
		...result,
		content: result.content.map((part, index) =>
			index === 0 && part.type === "text"
				? { ...part, text: `${part.text}\n\n[Hashline anchors unavailable: ${reason}]` }
				: part,
		),
	};
}

function numberedReadOutput(args: {
	cwd: string;
	displayAbsolute: string;
	normalized: string;
	offset?: number;
	limit?: number;
	snapshots: SnapshotStore;
	canonical: string;
}): AgentToolResult<ReadToolDetails | undefined> {
	const allLines = args.normalized.split("\n");
	const startLineIndex = args.offset ? Math.max(0, args.offset - 1) : 0;
	if (startLineIndex >= allLines.length) {
		throw new Error(`Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`);
	}

	const selectedEnd = args.limit === undefined
		? allLines.length
		: Math.min(startLineIndex + args.limit, allLines.length);
	const selected = allLines.slice(startLineIndex, selectedEnd).join("\n");
	const truncation = truncateHead(selected);
	if (truncation.firstLineExceedsLimit) {
		const lineNumber = startLineIndex + 1;
		const lineSize = formatSize(Buffer.byteLength(allLines[startLineIndex] ?? "", "utf8"));
		return {
			content: [{
				type: "text",
				text: `[Line ${lineNumber} is ${lineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash to inspect a bounded slice.]\n\n[Hashline anchors unavailable: the displayed line is incomplete.]`,
			}],
			details: { truncation },
		};
	}

	const shownLineCount = truncation.outputLines;
	const displayedLineCount = truncation.content.split("\n").length;
	const shownLines = Array.from({ length: displayedLineCount }, (_, index) => startLineIndex + index + 1);
	const tag = args.snapshots.record(args.canonical, args.normalized, shownLines);
	const header = formatHashlineHeader(displayPath(args.displayAbsolute, args.cwd), tag);
	let output = `${header}\n${formatNumberedLines(truncation.content, startLineIndex + 1)}`;

	if (truncation.truncated) {
		const endLine = startLineIndex + shownLineCount;
		const nextOffset = endLine + 1;
		const limitText = truncation.truncatedBy === "lines"
			? `${DEFAULT_MAX_LINES} line limit`
			: `${formatSize(DEFAULT_MAX_BYTES)} limit`;
		output += `\n\n[Showing lines ${startLineIndex + 1}-${endLine} of ${allLines.length} (${limitText}). Use offset=${nextOffset} to continue.]`;
	} else if (args.limit !== undefined && selectedEnd < allLines.length) {
		const remaining = allLines.length - selectedEnd;
		output += `\n\n[${remaining} more lines in file. Use offset=${selectedEnd + 1} to continue.]`;
	}

	return {
		content: [{ type: "text", text: output }],
		details: truncation.truncated ? { truncation } : undefined,
	};
}

function sectionDiff(result: PatchSectionResult): { diff: string; firstChangedLine: number | undefined } {
	if (result.op === "delete" || result.op === "noop") return { diff: "", firstChangedLine: undefined };
	return generateDiffString(result.before, result.after);
}

function renderSectionResult(result: PatchSectionResult): { text: string; perFile: PerFileEditResult } {
	const generated = sectionDiff(result);
	const diff = generated.diff;
	if (result.op === "delete") {
		return {
			text: `Deleted ${result.path}`,
			perFile: { path: result.path, op: result.op, diff, fileHash: result.fileHash },
		};
	}
	if (result.op === "noop") {
		return {
			text: `Edits to ${result.path} parsed and applied cleanly, but produced no change. Re-read before issuing another edit.`,
			perFile: { path: result.path, op: result.op, diff, fileHash: result.fileHash },
		};
	}

	const preview = buildCompactDiffPreview(diff);
	const blocks = result.blockResolutions?.map(resolution => {
		const span = resolution.start === resolution.end
			? `line ${resolution.start}`
			: `lines ${resolution.start}-${resolution.end}`;
		return `Block at ${resolution.anchorLine} resolved to ${span}`;
	}) ?? [];
	const textParts = [result.header, ...blocks];
	if (result.moveDest) textParts.push(`Moved to ${result.moveDest}`);
	if (preview.preview) textParts.push(preview.preview);
	if (result.warnings.length > 0) textParts.push(`Warnings:\n${result.warnings.join("\n")}`);
	const firstChangedLine = result.firstChangedLine ?? generated.firstChangedLine;
	return {
		text: textParts.join("\n"),
		perFile: {
			path: result.moveDest ?? result.path,
			op: result.op,
			diff,
			fileHash: result.fileHash,
			...(firstChangedLine === undefined ? {} : { firstChangedLine }),
		},
	};
}

async function withMutationQueues<T>(paths: readonly string[], operation: () => Promise<T>, index = 0): Promise<T> {
	if (index >= paths.length) return operation();
	return withFileMutationQueue(paths[index]!, () => withMutationQueues(paths, operation, index + 1));
}

export default function hashlineExtension(pi: ExtensionAPI): void {
	const prompt = HASHLINE_PROMPT;

	pi.on("session_start", (_event, ctx) => {
		getSessionState(ctx);
		ctx.ui.setStatus("hashline", "hashline");
	});

	pi.on("session_shutdown", (event, ctx) => {
		ctx.ui.setStatus("hashline", undefined);
		if (event.reason !== "reload") sessionStates.delete(sessionKey(ctx));
	});

	pi.registerCommand("hashline", {
		description: "Show hashline extension status",
		handler: async (_args, ctx) => {
			const state = getSessionState(ctx);
			ctx.ui.notify(`Hashline active for session ${sessionKey(ctx)}; ${state.clipboard.named?.size ?? 0} named register(s).`, "info");
		},
	});

	pi.registerTool({
		name: "read",
		label: "read",
		description: `Read text with an opaque whole-file snapshot tag and 1-indexed hashline rows. Output starts with [PATH#TAG], followed by LINE:TEXT. The tag is required by edit. Images retain Pi's normal attachment behavior. Text is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Files over ${formatSize(SNAPSHOT_MAX_BYTES)} are readable but do not receive hashline anchors.`,
		promptSnippet: "Read file contents with hashline snapshot anchors",
		promptGuidelines: [
			"Use read to examine files before edit; preserve the returned [PATH#TAG] header and LINE numbers for hashline edits.",
		],
		parameters: readSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			assertNotAborted(signal);
			const baseRead = createReadToolDefinition(ctx.cwd);
			const baseResult = await baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
			const baseText = baseResult.content.find(part => part.type === "text");
			if (
				baseResult.content.some(part => part.type === "image") ||
				(baseText?.type === "text" && baseText.text.startsWith("Read image file"))
			) return baseResult;

			let absolutePath: string | undefined;
			let rawBuffer: Buffer | undefined;
			const captureRead = createReadToolDefinition(ctx.cwd, {
				operations: {
					async access(resolvedPath) {
						absolutePath = resolvedPath;
						await fs.access(resolvedPath, fsConstants.R_OK);
					},
					async readFile(resolvedPath) {
						absolutePath = resolvedPath;
						rawBuffer = await fs.readFile(resolvedPath);
						return rawBuffer;
					},
				},
			});
			await captureRead.execute(toolCallId, params, signal, undefined, ctx);
			if (!absolutePath || !rawBuffer) throw new Error(`Pi resolved ${params.path}, but returned no text content.`);
			if (rawBuffer.byteLength > SNAPSHOT_MAX_BYTES) {
				return appendHashlineUnavailableNotice(baseResult, `file exceeds ${formatSize(SNAPSHOT_MAX_BYTES)} snapshot limit`);
			}
			const normalized = normalizeToLF(stripBom(rawBuffer.toString("utf8")).text);
			const filesystem = new PiFilesystem(ctx.cwd, signal);
			const canonical = filesystem.canonicalPath(params.path);
			return numberedReadOutput({
				cwd: ctx.cwd,
				displayAbsolute: absolutePath,
				normalized,
				offset: params.offset,
				limit: params.limit,
				snapshots: getSessionState(ctx).snapshots,
				canonical,
			});
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: prompt,
		promptSnippet: "Apply hashline patches anchored to read snapshot tags",
		promptGuidelines: [
			"Use edit only with [PATH#TAG] and LINE anchors from the latest hashline read; re-read after every edit because tags and line numbers change.",
		],
		parameters: editSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertNotAborted(signal);
			const patch = Patch.parse(params.input, { cwd: ctx.cwd });
			if (patch.sections.length === 0) throw new Error("No hashline sections found in input.");

			const filesystem = new PiFilesystem(ctx.cwd, signal);
			const queuedPaths = new Set<string>();
			for (const section of patch.sections) {
				queuedPaths.add(filesystem.canonicalPath(section.path));
				if (section.fileOp?.kind === "move") queuedPaths.add(filesystem.canonicalPath(section.fileOp.dest));
			}
			const sortedPaths = [...queuedPaths].sort();
			const state = getSessionState(ctx);

			return withMutationQueues(sortedPaths, async () => {
				assertNotAborted(signal);
				const patcher = new Patcher({
					fs: filesystem,
					snapshots: state.snapshots,
					blockResolver: nativeBlockResolver,
					enforceSeenLines: true,
					clipboard: state.clipboard,
				});
				let applied: Awaited<ReturnType<Patcher["apply"]>>;
				try {
					applied = await patcher.apply(patch);
				} finally {
					pruneNamedRegisters(state.clipboard);
				}
				const rendered = applied.sections.map(renderSectionResult);
				const perFileResults = rendered.map(item => item.perFile);
				const firstChangedLine = perFileResults.find(result => result.firstChangedLine !== undefined)?.firstChangedLine;
				return {
					content: [{ type: "text", text: rendered.map(item => item.text).join("\n\n") }],
					details: {
						diff: perFileResults.map(result => result.diff).filter(Boolean).join("\n"),
						...(firstChangedLine === undefined ? {} : { firstChangedLine }),
						perFileResults,
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const paths = [...args.input.matchAll(/^\[([^\]#]+)(?:#[0-9A-Fa-f]{4})?\]/gm)].map(match => match[1]);
			component.setText(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", paths.join(", ") || "hashline")}`);
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const textPart = result.content.find(part => part.type === "text");
			let text = textPart?.type === "text" ? textPart.text : "";
			const details = result.details as HashlineEditDetails | undefined;
			if (options.expanded && details?.diff) text += `\n\n${details.diff}`;
			component.setText(theme.fg(context.isError ? "error" : "toolOutput", text));
			return component;
		},
	});
}
