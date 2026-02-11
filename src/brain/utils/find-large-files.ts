import fg from "fast-glob";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { join, relative, sep } from "path";

export interface GitStatus {
	staged: boolean;
	modified: boolean;
	untracked: boolean;
}

export interface LargeFileThresholds {
	normal: number;
	high: number;
	critical: number;
}

export type LargeFileBucket = "normal" | "high" | "critical";

export interface LargeFileInfo {
	path: string;
	relativePath: string;
	lines: number;
	domain: string;
	bucket: LargeFileBucket;
	gitStatus?: GitStatus;
}

export interface FindLargeFilesOptions {
	rootDir?: string;
	srcDir?: string;
	minLines?: number;
	thresholds?: Partial<LargeFileThresholds>;
	extensions?: string[];
	ignore?: string[];
	includeGitStatus?: boolean;
}

const DEFAULT_THRESHOLDS: LargeFileThresholds = {
	normal: 400,
	high: 600,
	critical: 800,
};

const DEFAULT_EXTENSIONS = ["ts", "tsx", "js", "jsx"];
const DEFAULT_IGNORE = [
	"**/node_modules/**",
	"**/.git/**",
	"**/dist/**",
	"**/build/**",
	"**/coverage/**",
];

function normalizeRelativePath(path: string): string {
	return path.split(sep).join("/");
}

function getDomainFromRelativePath(relativePath: string): string {
	const normalized = normalizeRelativePath(relativePath);
	const parts = normalized.split("/");
	return parts[0] || "unknown";
}

function getBucket(lines: number, thresholds: LargeFileThresholds): LargeFileBucket {
	if (lines > thresholds.critical) return "critical";
	if (lines > thresholds.high) return "high";
	return "normal";
}

function getGitStatusMap(rootDir: string): Map<string, GitStatus> {
	try {
		const output = execSync("git status --porcelain", {
			cwd: rootDir,
			encoding: "utf-8",
		});
		const map = new Map<string, GitStatus>();
		for (const rawLine of output.split("\n")) {
			const line = rawLine.trimEnd();
			if (!line) continue;
			const status = line.slice(0, 2);
			const filePart = line.slice(3).trim();
			const filePath = filePart.includes(" -> ")
				? filePart.split(" -> ")[1] ?? filePart
				: filePart;
			const staged = status[0] !== " " && status[0] !== "?";
			const modified = status[1] !== " " && status[1] !== "?";
			const untracked = status === "??";
			map.set(normalizeRelativePath(filePath), {
				staged,
				modified,
				untracked,
			});
		}
		return map;
	} catch {
		return new Map();
	}
}

async function countLines(filePath: string): Promise<number> {
	const contents = await readFile(filePath, "utf-8");
	if (contents.length === 0) return 0;
	return contents.split(/\r\n|\r|\n/).length;
}

async function loadGitIgnorePatterns(rootDir: string): Promise<string[]> {
	const filePath = join(rootDir, ".gitignore");
	if (!existsSync(filePath)) return [];
	const contents = await readFile(filePath, "utf-8");
	return contents
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
}

export async function findLargeFiles(
	options: FindLargeFilesOptions = {},
): Promise<LargeFileInfo[]> {
	const rootDir = options.rootDir ?? process.cwd();
	const scanRoot = options.srcDir ?? join(rootDir, "src");
	const scanRelative = normalizeRelativePath(relative(rootDir, scanRoot));
	const thresholds: LargeFileThresholds = {
		...DEFAULT_THRESHOLDS,
		...options.thresholds,
	};
	const minLines = options.minLines ?? thresholds.normal;
	const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
	const gitIgnore = await loadGitIgnorePatterns(rootDir);
	const ignore = [...DEFAULT_IGNORE, ...gitIgnore, ...(options.ignore ?? [])];
	const gitStatusMap = options.includeGitStatus ? getGitStatusMap(rootDir) : null;
	const patterns = extensions.map((ext) => `${scanRelative}/**/*.${ext}`);

	const files = await fg(patterns, {
		cwd: rootDir,
		absolute: true,
		onlyFiles: true,
		followSymbolicLinks: false,
		ignore,
	});

	const results: LargeFileInfo[] = [];

	for (const filePath of files) {
		const lines = await countLines(filePath);
		if (lines <= minLines) continue;
		const relativePath = normalizeRelativePath(relative(rootDir, filePath));
		const bucket = getBucket(lines, thresholds);
		const domain = getDomainFromRelativePath(
			relativePath.replace(`${scanRelative}/`, ""),
		);
		const gitStatus = gitStatusMap?.get(relativePath);

		results.push({
			path: filePath,
			relativePath,
			lines,
			domain,
			bucket,
			gitStatus,
		});
	}

	results.sort((a, b) => {
		if (b.lines !== a.lines) return b.lines - a.lines;
		return a.relativePath.localeCompare(b.relativePath);
	});

	return results;
}

export function groupLargeFilesByDomain(
	files: LargeFileInfo[],
): Record<string, LargeFileInfo[]> {
	const grouped: Record<string, LargeFileInfo[]> = {};
	for (const file of files) {
		if (!grouped[file.domain]) grouped[file.domain] = [];
		grouped[file.domain]?.push(file);
	}
	return grouped;
}
