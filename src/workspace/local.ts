import { createHash } from "crypto";
import { execFile } from "child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { promisify } from "util";
import fg from "fast-glob";
import type {
	WorkspaceAccess,
	WorkspaceFileMetadata,
	WorkspaceScanOptions,
	WorkspaceTextFile,
	WorkspaceWriteOptions,
} from "./types";

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_FILES = 2_000;
const MAX_GIT_STATUS_BYTES = 1024 * 1024;
const FALLBACK_FILE_DEPTH = 6;

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
		try {
			const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
				cwd: this.root,
				encoding: "utf-8",
				maxBuffer: MAX_GIT_STATUS_BYTES,
			});
			return stdout;
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code === 128) return "";
			throw error;
		}
	}

	async gitFiles(): Promise<string[]> {
		try {
			const { stdout } = await execFileAsync("git", ["ls-files"], {
				cwd: this.root,
				encoding: "utf-8",
				maxBuffer: MAX_GIT_STATUS_BYTES,
			});
			return stdout.split("\n").filter((path) => path.length > 0);
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code === 128) {
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
			throw error;
		}
	}
}
