import { join, relative, sep } from "path";
import { LocalWorkspaceAccess, type WorkspaceAccess } from "../../workspace";

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
	workspace?: WorkspaceAccess;
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
	return normalizeRelativePath(relativePath).split("/")[0] || "unknown";
}

function getBucket(lines: number, thresholds: LargeFileThresholds): LargeFileBucket {
	if (lines > thresholds.critical) return "critical";
	if (lines > thresholds.high) return "high";
	return "normal";
}

function getGitStatusMap(output: string): Map<string, GitStatus> {
	const map = new Map<string, GitStatus>();
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		const status = line.slice(0, 2);
		const filePart = line.slice(3).trim();
		const filePath = filePart.includes(" -> ")
			? filePart.split(" -> ")[1] ?? filePart
			: filePart;
		map.set(normalizeRelativePath(filePath), {
			staged: status[0] !== " " && status[0] !== "?",
			modified: status[1] !== " " && status[1] !== "?",
			untracked: status === "??",
		});
	}
	return map;
}

async function loadGitIgnorePatterns(workspace: WorkspaceAccess): Promise<string[]> {
	const file = await workspace.readText(".gitignore");
	if (!file) return [];
	return file.content
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
}

export async function findLargeFiles(
	options: FindLargeFilesOptions = {},
): Promise<LargeFileInfo[]> {
	const rootDir = options.rootDir ?? process.cwd();
	const workspace = options.workspace || new LocalWorkspaceAccess(rootDir);
	const scanRoot = options.srcDir ?? join(rootDir, "src");
	const scanRelative = normalizeRelativePath(relative(rootDir, scanRoot));
	const thresholds: LargeFileThresholds = {
		...DEFAULT_THRESHOLDS,
		...options.thresholds,
	};
	const minLines = options.minLines ?? thresholds.normal;
	const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
	const gitIgnore = await loadGitIgnorePatterns(workspace);
	const ignore = [...DEFAULT_IGNORE, ...gitIgnore, ...(options.ignore ?? [])];
	const gitStatusMap = options.includeGitStatus
		? getGitStatusMap(await workspace.gitStatus())
		: null;
	const patterns = extensions.map((extension) => `${scanRelative}/**/*.${extension}`);
	const files = await workspace.scan(patterns, { ignore, includeLineCount: true });

	const results: LargeFileInfo[] = [];
	for (const file of files) {
		const lines = file.lineCount ?? 0;
		if (lines <= minLines) continue;
		const relativePath = normalizeRelativePath(file.path);
		results.push({
			path: join(rootDir, relativePath),
			relativePath,
			lines,
			domain: getDomainFromRelativePath(relativePath.replace(`${scanRelative}/`, "")),
			bucket: getBucket(lines, thresholds),
			gitStatus: gitStatusMap?.get(relativePath),
		});
	}

	results.sort((a, b) => b.lines - a.lines || a.relativePath.localeCompare(b.relativePath));
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
