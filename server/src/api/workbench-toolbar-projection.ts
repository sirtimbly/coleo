import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
	resolveToolbarTemplates,
	TOOLBAR_SCREEN_IDS,
} from "../workbench/toolbar-templates";

import type { WorkspaceTextFile } from "../workspace";
import type { ToolbarScreenId } from "../workbench/toolbar-templates";

export const WORKBENCH_TOOLBAR_PROJECTION_ROOT = ".coleo/state/workbench/toolbar-templates";

const PHYSICAL_PROJECTION_SEGMENTS = ["state", "workbench", "toolbar-templates"] as const;
const PROFILE_DIRECTORY = /^profile-[a-z0-9][a-z0-9._-]{0,39}-[a-f0-9]{64}$/;
const GENERATION_ID = /^[a-f0-9]{64}$/;
const RETAINED_GENERATIONS = 3;
const profileAccessQueues = new Map<string, Promise<void>>();

export interface WorkbenchToolbarProjectionFile extends WorkspaceTextFile {
	readOnly: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
	return isRecord(error) && typeof error.code === "string" && codes.includes(error.code);
}

function profileDirectory(profileId: string): string {
	const slug = profileId
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
		.slice(0, 40) || "profile";
	const digest = createHash("sha256").update(profileId).digest("hex");
	return `profile-${slug}-${digest}`;
}

function assertPathWithin(root: string, candidate: string): void {
	const relativePath = relative(root, candidate);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error("Generated toolbar configuration path escapes the Coleo directory");
	}
}

async function withProfileAccess<T>(
	coleoDir: string,
	profile: string,
	operation: () => Promise<T>,
): Promise<T> {
	const key = `${resolve(coleoDir)}\0${profile}`;
	const previous = profileAccessQueues.get(key) ?? Promise.resolve();
	let release: () => void = () => {};
	const current = new Promise<void>((resolveCurrent) => {
		release = resolveCurrent;
	});
	const queued = previous.catch(() => {}).then(() => current);
	profileAccessQueues.set(key, queued);
	await previous.catch(() => {});
	try {
		return await operation();
	} finally {
		release();
		if (profileAccessQueues.get(key) === queued) profileAccessQueues.delete(key);
	}
}

async function safeDirectory(
	coleoDir: string,
	segments: readonly string[],
	create: boolean,
): Promise<string> {
	if (create) await mkdir(coleoDir, { recursive: true });
	const coleoRoot = await realpath(coleoDir);
	let current = coleoDir;
	for (const segment of segments) {
		current = join(current, segment);
		if (create) {
			try {
				await mkdir(current);
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
			}
		}
		const metadata = await lstat(current);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error("Generated toolbar configuration directories cannot be filesystem links");
		}
		assertPathWithin(coleoRoot, await realpath(current));
	}
	return current;
}

async function readSafeFile(path: string): Promise<string | null> {
	try {
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
			throw new Error("Generated toolbar configurations must be regular, unlinked files");
		}
		return await readFile(path, "utf-8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
}

function projectionPathParts(path: string): { profile: string; screenId: ToolbarScreenId } | null {
	const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	const prefix = `${WORKBENCH_TOOLBAR_PROJECTION_ROOT}/`;
	if (!normalized.startsWith(prefix)) return null;
	const segments = normalized.slice(prefix.length).split("/");
	if (segments.length !== 2) return null;
	const [profile, filename] = segments;
	if (!profile || !PROFILE_DIRECTORY.test(profile) || !filename?.endsWith(".json")) return null;
	const screenId = TOOLBAR_SCREEN_IDS.find((candidate) => `${candidate}.json` === filename);
	return screenId ? { profile, screenId } : null;
}

function serializeTemplates(preferences: unknown): {
	contents: Record<ToolbarScreenId, string>;
	generationId: string;
} {
	const toolbarTemplates = isRecord(preferences) ? preferences.toolbarTemplates : undefined;
	const templates = resolveToolbarTemplates(toolbarTemplates);
	const contents = {} as Record<ToolbarScreenId, string>;
	const generationHash = createHash("sha256");
	for (const screenId of TOOLBAR_SCREEN_IDS) {
		const content = `${JSON.stringify(templates[screenId], null, 2)}\n`;
		contents[screenId] = content;
		generationHash.update(screenId).update("\0").update(content).update("\0");
	}
	return { contents, generationId: generationHash.digest("hex") };
}

async function writeAtomicIfChanged(path: string, content: string): Promise<void> {
	if (await readSafeFile(path) === content) return;
	const temporaryPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, content, { encoding: "utf-8", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function validateGeneration(
	directory: string,
	contents?: Record<ToolbarScreenId, string>,
): Promise<void> {
	for (const screenId of TOOLBAR_SCREEN_IDS) {
		const content = await readSafeFile(join(directory, `${screenId}.json`));
		if (content === null || (contents && content !== contents[screenId])) {
			throw new Error(`Toolbar configuration generation is incomplete: ${screenId}`);
		}
	}
}

async function ensureGeneration(
	coleoDir: string,
	profile: string,
	generationId: string,
	contents: Record<ToolbarScreenId, string>,
): Promise<void> {
	const generationSegments = [
		...PHYSICAL_PROJECTION_SEGMENTS,
		profile,
		"generations",
		generationId,
	];
	try {
		const existing = await safeDirectory(coleoDir, generationSegments, false);
		await validateGeneration(existing, contents);
		return;
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}

	const generationsDirectory = await safeDirectory(
		coleoDir,
		generationSegments.slice(0, -1),
		true,
	);
	const temporaryName = `.generation-${generationId}.${randomUUID()}.tmp`;
	const temporaryDirectory = await safeDirectory(
		coleoDir,
		[...generationSegments.slice(0, -1), temporaryName],
		true,
	);
	try {
		for (const screenId of TOOLBAR_SCREEN_IDS) {
			await writeFile(
				join(temporaryDirectory, `${screenId}.json`),
				contents[screenId],
				{ encoding: "utf-8", mode: 0o600 },
			);
		}
		try {
			await rename(temporaryDirectory, join(generationsDirectory, generationId));
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST", "ENOTEMPTY")) throw error;
		}
		const generationDirectory = await safeDirectory(coleoDir, generationSegments, false);
		await validateGeneration(generationDirectory, contents);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function removeLegacyScreenFiles(profileRoot: string): Promise<void> {
	for (const screenId of TOOLBAR_SCREEN_IDS) {
		const path = join(profileRoot, `${screenId}.json`);
		try {
			const metadata = await lstat(path);
			if (metadata.isDirectory()) {
				throw new Error(`Legacy toolbar configuration path is a directory: ${screenId}.json`);
			}
			await rm(path, { force: true });
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
		}
	}
}

async function pruneGenerations(
	coleoDir: string,
	profile: string,
	currentGenerationId: string,
): Promise<void> {
	const generationRootSegments = [...PHYSICAL_PROJECTION_SEGMENTS, profile, "generations"];
	const generationRoot = await safeDirectory(coleoDir, generationRootSegments, false);
	const entries = await readdir(generationRoot, { withFileTypes: true });
	const generations = await Promise.all(entries
		.filter((entry) => entry.isDirectory() && GENERATION_ID.test(entry.name))
		.map(async (entry) => ({
			id: entry.name,
			modifiedAt: (await stat(join(generationRoot, entry.name))).mtimeMs,
		})));
	const retained = new Set([
		currentGenerationId,
		...generations
			.filter((generation) => generation.id !== currentGenerationId)
			.sort((left, right) => right.modifiedAt - left.modifiedAt)
			.slice(0, RETAINED_GENERATIONS - 1)
			.map((generation) => generation.id),
	]);
	for (const generation of generations) {
		if (retained.has(generation.id)) continue;
		const directory = await safeDirectory(
			coleoDir,
			[...generationRootSegments, generation.id],
			false,
		);
		await rm(directory, { recursive: true });
	}
}

async function writeToolbarProjection(
	coleoDir: string,
	profileId: string,
	preferences: unknown,
): Promise<void> {
	const profile = profileDirectory(profileId);
	const { contents, generationId } = serializeTemplates(preferences);
	await ensureGeneration(coleoDir, profile, generationId, contents);
	const profileRoot = await safeDirectory(
		coleoDir,
		[...PHYSICAL_PROJECTION_SEGMENTS, profile],
		false,
	);
	await writeAtomicIfChanged(join(profileRoot, "current"), `${generationId}\n`);
	await removeLegacyScreenFiles(profileRoot);
	try {
		await pruneGenerations(coleoDir, profile, generationId);
	} catch (error) {
		console.error(
			`[workbench] Failed to prune old toolbar generations for ${profile}:`,
			error instanceof Error ? error.message : error,
		);
	}
}

async function currentGenerationDirectory(
	coleoDir: string,
	profile: string,
): Promise<string | null> {
	const profileSegments = [...PHYSICAL_PROJECTION_SEGMENTS, profile];
	let profileRoot: string;
	try {
		profileRoot = await safeDirectory(coleoDir, profileSegments, false);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
	const current = (await readSafeFile(join(profileRoot, "current")))?.trim();
	if (!current || !GENERATION_ID.test(current)) return null;
	return safeDirectory(
		coleoDir,
		[...profileSegments, "generations", current],
		false,
	);
}

export function getWorkbenchToolbarProjectionPaths(profileId: string): readonly string[] {
	const directory = profileDirectory(profileId);
	return TOOLBAR_SCREEN_IDS.map(
		(screenId) => `${WORKBENCH_TOOLBAR_PROJECTION_ROOT}/${directory}/${screenId}.json`,
	);
}

export function isWorkbenchToolbarProjectionPath(path: string): boolean {
	return projectionPathParts(path) !== null;
}

export async function materializeWorkbenchToolbarTemplates(
	coleoDir: string,
	profileId: string,
	preferences: unknown,
): Promise<readonly string[]> {
	const profile = profileDirectory(profileId);
	await withProfileAccess(coleoDir, profile, () => writeToolbarProjection(coleoDir, profileId, preferences));
	return getWorkbenchToolbarProjectionPaths(profileId);
}

export async function listWorkbenchToolbarProjectionPaths(coleoDir: string): Promise<string[]> {
	let root: string;
	try {
		root = await safeDirectory(coleoDir, PHYSICAL_PROJECTION_SEGMENTS, false);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}
	let directories: Dirent<string>[];
	try {
		directories = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}

	const paths: string[] = [];
	for (const directory of directories) {
		if (!directory.isDirectory() || !PROFILE_DIRECTORY.test(directory.name)) continue;
		try {
			const available = await withProfileAccess(coleoDir, directory.name, async () => {
				const generationDirectory = await currentGenerationDirectory(coleoDir, directory.name);
				if (!generationDirectory) return false;
				await validateGeneration(generationDirectory);
				return true;
			});
			if (!available) continue;
			paths.push(...TOOLBAR_SCREEN_IDS.map(
				(screenId) => `${WORKBENCH_TOOLBAR_PROJECTION_ROOT}/${directory.name}/${screenId}.json`,
			));
		} catch {
			// A corrupt profile snapshot should not hide valid snapshots from other profiles.
		}
	}
	return paths.sort();
}

export async function readWorkbenchToolbarProjectionFile(
	coleoDir: string,
	path: string,
): Promise<WorkbenchToolbarProjectionFile | null> {
	const parts = projectionPathParts(path);
	if (!parts) return null;
	const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	try {
		return await withProfileAccess(coleoDir, parts.profile, async () => {
			const generationDirectory = await currentGenerationDirectory(coleoDir, parts.profile);
			if (!generationDirectory) return null;
			const absolutePath = join(generationDirectory, `${parts.screenId}.json`);
			const content = await readSafeFile(absolutePath);
			if (content === null) return null;
			const metadata = await stat(absolutePath);
			return {
				path: normalized,
				content,
				contentHash: createHash("sha256").update(content).digest("hex"),
				size: metadata.size,
				modifiedAt: metadata.mtime.toISOString(),
				readOnly: true as const,
			};
		});
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
}
