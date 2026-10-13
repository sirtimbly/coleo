import { createHash } from "crypto";
import { spawn } from "child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import fg from "fast-glob";
import type {
	WorkspaceAccess,
	WorkspaceFileMetadata,
	WorkspaceScanOptions,
	WorkspaceTextFile,
	WorkspaceWriteOptions,
} from "./types";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_FILES = 2_000;
const MAX_GIT_OUTPUT_BYTES = 100_000;
const MAX_GIT_OUTPUT_ENTRIES = 1_000;
const FALLBACK_FILE_DEPTH = 6;

interface BoundedGitOutput {
	output: string;
	code: number | null;
	truncated: boolean;
}

function runBoundedGit(root: string, args: string[]): Promise<BoundedGitOutput> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", args, { cwd: root });
		let output = "";
		let stderr = "";
		let truncated = false;

		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			if (truncated) return;
			const lines = `${output}${chunk}`.split("\n");
			if (lines.length - 1 > MAX_GIT_OUTPUT_ENTRIES) {
				output = `${lines.slice(0, MAX_GIT_OUTPUT_ENTRIES).join("\n")}\n`;
				truncated = true;
			} else {
				output += chunk;
			}

			if (Buffer.byteLength(output, "utf-8") > MAX_GIT_OUTPUT_BYTES) {
				output = Buffer.from(output, "utf-8").subarray(0, MAX_GIT_OUTPUT_BYTES).toString("utf-8");
				truncated = true;
			}
			if (truncated) child.kill("SIGTERM");
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 10_000) stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0 && code !== 128 && !truncated) {
				reject(new Error(stderr.trim() || `git ${args[0] || "command"} failed (${code})`));
				return;
			}
			resolvePromise({ output, code, truncated });
		});
	});
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function normalizedRelativePath(root: string, input: string): string {
	if (!input || input.includes("\0")) {
		throw new Error("Workspace path is required");
	}

	const candidate = isAbsolute(input) ? relative(root, input) : input;
	const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
	if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
		throw new Error(`Workspace path escapes the configured root: ${input}`);
	}
	return normalized;
}

function validatePatterns(patterns: string[], allowEmpty = false): string[] {
	if ((!allowEmpty && patterns.length === 0) || patterns.length > 25) {
		throw new Error("Workspace scan requires between 1 and 25 patterns");
	}
	return patterns.map((pattern) => {
		if (!pattern || pattern.includes("\0") || isAbsolute(pattern)) {
			throw new Error(`Invalid workspace scan pattern: ${pattern}`);
		}
		const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
		if (normalized.split("/").includes("..")) {
			throw new Error(`Workspace scan pattern escapes the configured root: ${pattern}`);
		}
		return normalized;
	});
}

export class LocalWorkspaceAccess implements WorkspaceAccess {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	private resolvePath(path: string): { absolute: string; relative: string } {
		const relativePath = normalizedRelativePath(this.root, path);
		const absolute = resolve(this.root, relativePath);
		const relativeToRoot = relative(this.root, absolute);
		if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
			throw new Error(`Workspace path escapes the configured root: ${path}`);
		}
		return { absolute, relative: relativePath };
	}

	private async assertRealPathWithinRoot(path: string): Promise<void> {
		const [rootPath, candidatePath] = await Promise.all([realpath(this.root), realpath(path)]);
		const relativePath = relative(rootPath, candidatePath);
		if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error("Workspace symlink escapes the configured root");
		}
	}

	async readText(path: string): Promise<WorkspaceTextFile | null> {
		const resolved = this.resolvePath(path);
		try {
			await this.assertRealPathWithinRoot(resolved.absolute);
			const fileStat = await stat(resolved.absolute);
			if (!fileStat.isFile()) return null;
			if (fileStat.size > MAX_TEXT_BYTES) {
				throw new Error(`Workspace text file exceeds ${MAX_TEXT_BYTES} bytes: ${resolved.relative}`);
			}
			const content = await readFile(resolved.absolute, "utf-8");
			return {
				path: resolved.relative,
				content,
				contentHash: hashContent(content),
				size: fileStat.size,
				modifiedAt: fileStat.mtime.toISOString(),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async writeText(
		path: string,
		content: string,
		options: WorkspaceWriteOptions = {},
	): Promise<WorkspaceTextFile> {
		if (Buffer.byteLength(content, "utf-8") > MAX_TEXT_BYTES) {
			throw new Error(`Workspace text write exceeds ${MAX_TEXT_BYTES} bytes`);
		}

		const resolved = this.resolvePath(path);
		await mkdir(dirname(resolved.absolute), { recursive: true });
		await this.assertRealPathWithinRoot(dirname(resolved.absolute));
		try {
			await this.assertRealPathWithinRoot(resolved.absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		if (options.expectedHash !== undefined) {
			const existing = await this.readText(resolved.relative);
			const actualHash = existing?.contentHash ?? null;
			if (actualHash !== options.expectedHash) {
				throw new Error(`Workspace file changed before write: ${resolved.relative}`);
			}
		}

		await writeFile(resolved.absolute, content, "utf-8");
		const written = await this.readText(resolved.relative);
		if (!written) throw new Error(`Workspace file was not readable after write: ${resolved.relative}`);
		return written;
	}

	async scan(
		patterns: string[],
		options: WorkspaceScanOptions = {},
	): Promise<WorkspaceFileMetadata[]> {
		const normalizedPatterns = validatePatterns(patterns);
		const maxFiles = Math.min(Math.max(options.maxFiles ?? MAX_SCAN_FILES, 1), MAX_SCAN_FILES);
		const ignore = validatePatterns(
			options.ignore ?? ["**/.git/**", "**/node_modules/**"],
			true,
		);
		const matches = await fg(normalizedPatterns, {
			cwd: this.root,
			onlyFiles: true,
			followSymbolicLinks: false,
			unique: true,
			dot: options.dot ?? false,
			ignore,
		});
		if (matches.length > maxFiles) {
			throw new Error(`Workspace scan matched ${matches.length} files; limit is ${maxFiles}`);
		}

		const files: WorkspaceFileMetadata[] = [];
		for (const match of matches.sort()) {
			const file = await this.readText(match);
			if (!file) continue;
			files.push({
				path: file.path,
				contentHash: file.contentHash,
				size: file.size,
				modifiedAt: file.modifiedAt,
				...(options.includeLineCount
					? { lineCount: file.content.length === 0 ? 0 : file.content.split(/\r\n|\r|\n/).length }
					: {}),
			});
		}
		return files;
	}

	async gitStatus(): Promise<string> {
		const result = await runBoundedGit(this.root, ["status", "--porcelain", "--untracked-files=all"]);
		if (result.code === 128) return "";
		return result.truncated
			? `${result.output.trimEnd()}\n... [git status truncated]\n`
			: result.output;
	}

	async gitFiles(): Promise<string[]> {
		const result = await runBoundedGit(this.root, ["ls-files"]);
		if (result.code === 128) {
			return (await fg(["**/*"], {
					cwd: this.root,
					onlyFiles: true,
					followSymbolicLinks: false,
					unique: true,
					dot: true,
					deep: FALLBACK_FILE_DEPTH,
					ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/vendor/**"],
			})).sort().slice(0, MAX_SCAN_FILES);
		}
		return result.output.split("\n").filter((path) => path.length > 0);
	}
}
