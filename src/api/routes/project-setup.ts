import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";

import { parsePlanFile } from "../../brain/plan-parser";
import { createSqliteBrainDb } from "../../db/brain-db-adapter";
import {
	CANONICAL_PLAN_PATH,
	DEFAULT_ARM_TEMPLATE,
	DEFAULT_PLAN_TEMPLATE,
	discoverProjectPlans,
	formatPlanWithConfiguredModel,
	hasStructuredPlanTasks,
	validateEditablePlanPath,
	validateEditableTemplatePath,
	type PlanFormatter,
} from "../../project-setup/service";
import { getColeoDir } from "../../config";
import type { WorkspaceAccess, WorkspaceTextFile } from "../../workspace";
import { HttpError } from "../middleware";
import { getServerWorkspaceAccess } from "../workspace-access";

interface ProjectSetupContext {
	Variables: {
		db: Database;
	};
}

export interface ProjectSetupRouteOptions {
	workspace?: WorkspaceAccess;
	formatter?: PlanFormatter;
	coleoDir?: string;
}

interface ArmTemplateFile extends WorkspaceTextFile {
	format: "yaml" | "toml";
}

async function listArmTemplateFiles(coleoDir: string): Promise<ArmTemplateFile[]> {
	const locations = [
		{ directory: "templates", extension: /\.ya?ml$/i, format: "yaml" as const },
		{ directory: "arms", extension: /\.toml$/i, format: "toml" as const },
	];
	const files: ArmTemplateFile[] = [];
	for (const location of locations) {
		let names: string[];
		try {
			names = await readdir(join(coleoDir, location.directory));
		} catch {
			continue;
		}
		for (const name of names.filter((entry) => location.extension.test(entry)).sort()) {
			const absolutePath = join(coleoDir, location.directory, name);
			const [content, metadata] = await Promise.all([readFile(absolutePath, "utf-8"), stat(absolutePath)]);
			files.push({
				path: `.coleo/${location.directory}/${name}`,
				content,
				contentHash: createHash("sha256").update(content).digest("hex"),
				size: metadata.size,
				modifiedAt: metadata.mtime.toISOString(),
				format: location.format,
			});
		}
	}
	return files;
}

async function writeArmTemplateFile(
	coleoDir: string,
	path: string,
	content: string,
	expectedHash?: string | null,
): Promise<ArmTemplateFile> {
	const validated = validateEditableTemplatePath(path);
	const relativePath = validated.replace(/^\.coleo\//, "");
	const absolutePath = join(coleoDir, relativePath);
	let existing: string | null = null;
	try {
		existing = await readFile(absolutePath, "utf-8");
	} catch {
		// A missing file is valid when the caller is creating a new template.
	}
	const existingHash = existing === null ? null : createHash("sha256").update(existing).digest("hex");
	if (expectedHash !== undefined && expectedHash !== existingHash) {
		throw new Error("This template changed since you opened it. Reload before saving your edits.");
	}
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf-8");
	const metadata = await stat(absolutePath);
	return {
		path: validated,
		content,
		contentHash: createHash("sha256").update(content).digest("hex"),
		size: metadata.size,
		modifiedAt: metadata.mtime.toISOString(),
		format: validated.endsWith(".toml") ? "toml" : "yaml",
	};
}

function taskCount(db: Database): number {
	return (db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number } | null)?.count ?? 0;
}

function badRequestFrom(error: unknown, fallback: string): HttpError {
	return HttpError.badRequest(error instanceof Error ? error.message : fallback);
}

export function createProjectSetupRoutes(options: ProjectSetupRouteOptions = {}) {
	const app = new Hono<ProjectSetupContext>();
	const getWorkspace = (): WorkspaceAccess => options.workspace ?? getServerWorkspaceAccess();
	const formatter = options.formatter ?? formatPlanWithConfiguredModel;
	const coleoDir = options.coleoDir ?? getColeoDir();

	app.get("/", async (c) => {
		const workspace = getWorkspace();
		const db = c.get("db");
		const [candidates, canonical, templateFiles] = await Promise.all([
			discoverProjectPlans(workspace),
			workspace.readText(CANONICAL_PLAN_PATH),
			listArmTemplateFiles(coleoDir),
		]);
		const parsed = canonical ? await parsePlanFile(CANONICAL_PLAN_PATH, workspace) : null;
		const tasks = taskCount(db);
		const canonicalTaskCount = parsed?.tasks.length ?? 0;

		return c.json({
			required: tasks === 0 && canonicalTaskCount === 0,
			completed: tasks > 0 || canonicalTaskCount > 0,
			taskCount: tasks,
			canonicalPlan: canonical,
			canonicalTaskCount,
			candidates,
			templateFiles,
			recommendedPath: candidates[0]?.path ?? CANONICAL_PLAN_PATH,
			defaultContent: DEFAULT_PLAN_TEMPLATE,
			defaultTemplateContent: DEFAULT_ARM_TEMPLATE,
		});
	});

	app.put("/file", async (c) => {
		const workspace = getWorkspace();
		const body = await c.req.json<{
			path?: unknown;
			content?: unknown;
			expectedHash?: unknown;
			kind?: unknown;
		}>();
		if (typeof body.path !== "string" || typeof body.content !== "string") {
			throw HttpError.badRequest("path and content are required");
		}
		if (body.expectedHash !== undefined && body.expectedHash !== null && typeof body.expectedHash !== "string") {
			throw HttpError.badRequest("expectedHash must be a string or null");
		}
		if (body.kind !== undefined && body.kind !== "plan" && body.kind !== "template") {
			throw HttpError.badRequest("kind must be plan or template");
		}
		if (Buffer.byteLength(body.content, "utf-8") > 512 * 1024) {
			throw HttpError.badRequest("Setup files must be smaller than 512 KiB");
		}

		try {
			if (body.kind === "template") {
				const file = await writeArmTemplateFile(
					coleoDir,
					body.path,
					body.content,
					body.expectedHash as string | null | undefined,
				);
				return c.json({ file });
			}
			const path = validateEditablePlanPath(body.path);
			const file = await workspace.writeText(path, body.content, {
				expectedHash: body.expectedHash as string | null | undefined,
			});
			return c.json({ file });
		} catch (error) {
			throw badRequestFrom(error, "Unable to save the plan file");
		}
	});

	app.post("/prepare", async (c) => {
		const workspace = getWorkspace();
		const db = c.get("db");
		const body = await c.req.json<{
			sourcePath?: unknown;
			content?: unknown;
			expectedHash?: unknown;
		}>();
		if (typeof body.sourcePath !== "string" || typeof body.content !== "string") {
			throw HttpError.badRequest("sourcePath and content are required");
		}
		if (!body.content.trim()) throw HttpError.badRequest("Write or select a project plan before creating tasks");
		if (body.expectedHash !== undefined && body.expectedHash !== null && typeof body.expectedHash !== "string") {
			throw HttpError.badRequest("expectedHash must be a string or null");
		}
		if (Buffer.byteLength(body.content, "utf-8") > 512 * 1024) {
			throw HttpError.badRequest("Plan files must be smaller than 512 KiB");
		}

		try {
			const sourcePath = validateEditablePlanPath(body.sourcePath);
			const sourceExpectedHash = body.expectedHash as string | null | undefined;
			if (sourcePath !== CANONICAL_PLAN_PATH) {
				await workspace.writeText(sourcePath, body.content, { expectedHash: sourceExpectedHash });
			}

			const formatted = await formatter(body.content, sourcePath);
			if (!hasStructuredPlanTasks(formatted.content)) {
				throw new Error("The prepared plan did not contain a phase with deliverable checklist items");
			}
			const existingCanonical = await workspace.readText(CANONICAL_PLAN_PATH);
			const canonicalExpectedHash = sourcePath === CANONICAL_PLAN_PATH
				? sourceExpectedHash
				: existingCanonical?.contentHash ?? null;
			const canonicalPlan = await workspace.writeText(CANONICAL_PLAN_PATH, formatted.content, {
				expectedHash: canonicalExpectedHash,
			});
			const parsed = await parsePlanFile(CANONICAL_PLAN_PATH, workspace);
			if (parsed.errors.length > 0) throw new Error(parsed.errors.join("; "));
			if (parsed.tasks.length === 0) {
				throw new Error("The prepared plan did not contain any tasks. Add concrete goals or checklist items and try again.");
			}

			const brainDb = createSqliteBrainDb(db);
			const existingTaskIds = new Set(brainDb.listTasks({ limit: 10_000 }).map((task) => task.id));
			let createdTaskCount = 0;
			const createTasks = db.transaction(() => {
				for (const task of parsed.tasks) {
					if (existingTaskIds.has(task.id)) continue;
					brainDb.createTask({
						id: task.id,
						subject: task.subject,
						description: task.description,
						status: task.status,
						priority: task.priority,
						sourceType: "plan",
						sourceRef: task.sourceRef,
						phase: task.phase || null,
					});
					existingTaskIds.add(task.id);
					createdTaskCount += 1;
				}
			});
			createTasks();

			return c.json({
				completed: true,
				mode: formatted.mode,
				canonicalPlan,
				taskCount: parsed.tasks.length,
				createdTaskCount,
			});
		} catch (error) {
			throw badRequestFrom(error, "Unable to prepare the project plan");
		}
	});

	return app;
}
