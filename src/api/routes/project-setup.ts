import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";

import { parsePlanFile } from "../../brain/plan-parser";
import { regenerateTasksFromPlan } from "../../brain/task-regenerator";
import { BrainTemplateManager } from "../../brain/template-manager";
import {
	getBrainModelAccessIssue,
	serializeBrainModelAccessIssue,
	type BrainModelAccessIssue,
} from "../../brain/model-access";
import {
	CANONICAL_PLAN_PATH,
	DEFAULT_ARM_TEMPLATE,
	DEFAULT_PLAN_TEMPLATE,
	collectPlanWorkspaceContext,
	discoverProjectPlans,
	formatPlanWithConfiguredModel,
	hasStructuredPlanTasks,
	listProjectPlanDocuments,
	validateEditablePlanPath,
	validateEditableTemplatePath,
	type PlanFormatter,
} from "../../project-setup/service";
import { getColeoDir } from "../../config";
import { updateInfrastructureHealth } from "../../db/transactions";
import type { WorkspaceAccess, WorkspaceTextFile } from "../../workspace";
import { HttpError } from "../middleware";
import {
	isWorkbenchToolbarProjectionPath,
	listWorkbenchToolbarProjectionPaths,
	readWorkbenchToolbarProjectionFile,
} from "../workbench-toolbar-projection";
import { getServerWorkspaceAccess } from "../workspace-access";
import { broadcast } from "../websocket";

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

interface SetupTemplateFile extends WorkspaceTextFile {
	format: "yaml" | "toml" | "jinja";
}

async function listSetupTemplateFiles(coleoDir: string): Promise<SetupTemplateFile[]> {
	const locations = [
		{ directory: "templates", extension: /\.ya?ml$/i, format: "yaml" as const },
		{ directory: "arms", extension: /\.toml$/i, format: "toml" as const },
		{ directory: "src/brain/templates", extension: /\.jinja$/i, format: "jinja" as const },
	];
	const files: SetupTemplateFile[] = [];
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

async function writeSetupTemplateFile(
	coleoDir: string,
	path: string,
	content: string,
	expectedHash?: string | null,
): Promise<SetupTemplateFile> {
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
		format: validated.endsWith(".toml") ? "toml" : validated.endsWith(".jinja") ? "jinja" : "yaml",
	};
}

function taskCount(db: Database): number {
	return (db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number } | null)?.count ?? 0;
}

const EDITABLE_DOCUMENT_PATH = /^(?:[^/]+\/)*[^/]+\.(?:md|markdown|txt|toml|jinja)$/i;

function validateEditableDocumentPath(path: string): string {
	const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
		throw new Error("Choose a file inside the project workspace");
	}
	if (!EDITABLE_DOCUMENT_PATH.test(normalized)) {
		throw new Error("Only Markdown (.md), text (.txt), TOML (.toml), and Jinja (.jinja) files can be viewed and edited here");
	}
	return normalized;
}

function badRequestFrom(error: unknown, fallback: string): HttpError {
	return HttpError.badRequest(error instanceof Error ? error.message : fallback);
}

async function recordBrainModelAccess(
	db: Database,
	issue: BrainModelAccessIssue | null,
): Promise<void> {
	const result = await updateInfrastructureHealth(db, [
		{
			component: "brain_model_api",
			healthy: issue === null,
			optional: false,
			error: issue ? serializeBrainModelAccessIssue(issue) : undefined,
		},
	]);
	if (!result.success) return;
	broadcast("brain", "brain.model_access_changed", {
		status: issue ? "blocked" : "available",
		issueCode: issue?.code,
	});
}

async function listProjectTreePaths(workspace: WorkspaceAccess): Promise<string[]> {
	const tracked = await workspace.gitFiles();
	if (tracked.length > 0) return tracked.sort();
	try {
		const scanned = await workspace.scan(["**/*"], { dot: true });
		return scanned.map((file) => file.path);
	} catch {
		return [];
	}
}

export function createProjectSetupRoutes(options: ProjectSetupRouteOptions = {}) {
	const app = new Hono<ProjectSetupContext>();
	const getWorkspace = (): WorkspaceAccess => options.workspace ?? getServerWorkspaceAccess();
	const formatter = options.formatter ?? formatPlanWithConfiguredModel;
	const coleoDir = options.coleoDir ?? getColeoDir();
	const brainTemplates = new BrainTemplateManager(coleoDir, () => {});

	app.get("/", async (c) => {
		const workspace = getWorkspace();
		const db = c.get("db");
		await brainTemplates.ensureTemplatesExist();
		const [candidates, canonical, projectDocuments, templateFiles, workspaceTree, toolbarPaths] = await Promise.all([
			discoverProjectPlans(workspace),
			workspace.readText(CANONICAL_PLAN_PATH),
			listProjectPlanDocuments(workspace),
			listSetupTemplateFiles(coleoDir),
			listProjectTreePaths(workspace),
			listWorkbenchToolbarProjectionPaths(coleoDir),
		]);
		const parsed = canonical ? await parsePlanFile(CANONICAL_PLAN_PATH, workspace) : null;
		const tasks = taskCount(db);
		const canonicalTaskCount = parsed?.tasks.length ?? 0;
		const projectTree = Array.from(new Set([
			...workspaceTree,
			...templateFiles.map((file) => file.path),
			...toolbarPaths,
		])).sort();

		return c.json({
			required: tasks === 0 && canonicalTaskCount === 0,
			completed: tasks > 0 || canonicalTaskCount > 0,
			taskCount: tasks,
			canonicalPlan: canonical,
			canonicalTaskCount,
			candidates,
			projectDocuments,
			templateFiles,
			projectTree,
			recommendedPath: candidates[0]?.path ?? CANONICAL_PLAN_PATH,
			defaultContent: DEFAULT_PLAN_TEMPLATE,
			defaultTemplateContent: DEFAULT_ARM_TEMPLATE,
		});
	});

	app.get("/file", async (c) => {
		const workspace = getWorkspace();
		const rawPath = c.req.query("path");
		if (!rawPath) throw HttpError.badRequest("path is required");
		if (isWorkbenchToolbarProjectionPath(rawPath)) {
			const file = await readWorkbenchToolbarProjectionFile(coleoDir, rawPath);
			if (!file) throw HttpError.notFound("Toolbar configuration snapshot not found");
			return c.json({ file });
		}

		try {
			const path = validateEditableDocumentPath(rawPath);
			const file = await workspace.readText(path);
			if (!file) throw HttpError.notFound("File not found in the project workspace");
			return c.json({ file });
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw badRequestFrom(error, "Unable to read the file");
		}
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
		if (isWorkbenchToolbarProjectionPath(body.path)) {
			throw HttpError.badRequest("Toolbar configuration snapshots are read-only. Edit them in Toolbar Playground.");
		}
		if (body.expectedHash !== undefined && body.expectedHash !== null && typeof body.expectedHash !== "string") {
			throw HttpError.badRequest("expectedHash must be a string or null");
		}
		if (body.kind !== undefined && body.kind !== "plan" && body.kind !== "template" && body.kind !== "document") {
			throw HttpError.badRequest("kind must be plan, template, or document");
		}
		if (Buffer.byteLength(body.content, "utf-8") > 512 * 1024) {
			throw HttpError.badRequest("Setup files must be smaller than 512 KiB");
		}

		try {
			if (body.kind === "template") {
				const file = await writeSetupTemplateFile(
					coleoDir,
					body.path,
					body.content,
					body.expectedHash as string | null | undefined,
				);
				return c.json({ file });
			}
			const path = body.kind === "document"
				? validateEditableDocumentPath(body.path)
				: validateEditablePlanPath(body.path);
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

			const workspaceContext = await collectPlanWorkspaceContext(workspace);
			const formatted = await formatter(
				body.content,
				sourcePath,
				undefined,
				workspaceContext,
				brainTemplates,
			);
			if (formatted.modelIssue) {
				await recordBrainModelAccess(c.get("db"), formatted.modelIssue);
			} else if (formatted.mode === "ai") {
				await recordBrainModelAccess(c.get("db"), null);
			}
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

			return c.json({
				completed: true,
				mode: formatted.mode,
				formatterError: formatted.formatterError,
				canonicalPlan,
				taskCount: parsed.tasks.length,
			});
		} catch (error) {
			const issue = getBrainModelAccessIssue(error);
			if (issue) await recordBrainModelAccess(c.get("db"), issue);
			throw badRequestFrom(error, "Unable to prepare the project plan");
		}
	});

	app.post("/regenerate-tasks", async (c) => {
		const body = await c.req.json<{ explanation?: unknown }>();
		if (typeof body.explanation !== "string" || !body.explanation.trim()) {
			throw HttpError.badRequest("Explain why the task list needs to be regenerated");
		}
		if (body.explanation.length > 4_000) {
			throw HttpError.badRequest("The regeneration explanation must be 4,000 characters or fewer");
		}

		try {
			const result = await regenerateTasksFromPlan({
				db: c.get("db"),
				workspace: getWorkspace(),
				explanation: body.explanation,
				formatter,
				templates: brainTemplates,
			});
			if (result.mode === "ai") {
				await recordBrainModelAccess(c.get("db"), null);
			}
			broadcast("tasks", "tasks.regenerated", result);
			return c.json(result);
		} catch (error) {
			const issue = getBrainModelAccessIssue(error);
			if (issue) await recordBrainModelAccess(c.get("db"), issue);
			throw badRequestFrom(error, "Unable to regenerate tasks from the project plan");
		}
	});

	return app;
}
