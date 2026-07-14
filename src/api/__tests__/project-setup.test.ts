import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { LocalWorkspaceAccess } from "../../workspace";
import { formatErrorResponse } from "../middleware/error";
import { createProjectSetupRoutes } from "../routes/project-setup";

function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			subject TEXT NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL,
			priority TEXT NOT NULL,
			source_type TEXT,
			source_ref TEXT,
			phase TEXT,
			domain TEXT,
			classification TEXT,
			assigned_to TEXT,
			dependency_blocked INTEGER DEFAULT 0,
			sort_order INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		);
	`);
	return db;
}

describe("project setup routes", () => {
	let root: string;
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "coleo-project-setup-api-"));
		db = createTestDb();
		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});
		app.onError((error, c) => formatErrorResponse(c, error));
		app.route("/api/project-setup", createProjectSetupRoutes({
			workspace: new LocalWorkspaceAccess(root),
			coleoDir: join(root, ".coleo"),
			formatter: async (content) => ({
				mode: "structured",
				content: content.includes("### Deliverables")
					? content
					: `${content.trimEnd()}\n\n## Phase 1: Launch\n\n### Deliverables\n\n- [ ] Build the first release\n`,
			}),
		}));
	});

	afterEach(async () => {
		db.close();
		await rm(root, { recursive: true, force: true });
	});

	it("reports candidate files for an empty project", async () => {
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(join(root, "docs", "project-plan.md"), "# Project Plan\n\n## Goals\n- Ship the app\n");

		const response = await app.request("http://localhost/api/project-setup");
		const body = await response.json() as { required: boolean; candidates: Array<{ path: string }> };

		expect(response.status).toBe(200);
		expect(body.required).toBe(true);
		expect(body.candidates[0]?.path).toBe("docs/project-plan.md");
	});

	it("lists and edits Arm templates separately from project plans", async () => {
		await mkdir(join(root, ".coleo", "templates"), { recursive: true });
		await writeFile(join(root, ".coleo", "templates", "reviewer.yml"), "arm:\n  name: reviewer\n");

		const statusResponse = await app.request("http://localhost/api/project-setup");
		const status = await statusResponse.json() as {
			templateFiles: Array<{ path: string; content: string; contentHash: string; format: string }>;
		};
		const reviewer = status.templateFiles.find((file) => file.path === ".coleo/templates/reviewer.yml");
		expect(reviewer?.format).toBe("yaml");

		const saveResponse = await app.request("http://localhost/api/project-setup/file", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				kind: "template",
				path: ".coleo/templates/reviewer.yml",
				content: "arm:\n  name: careful-reviewer\n",
				expectedHash: reviewer?.contentHash,
			}),
		});
		const saved = await saveResponse.json() as { file: { content: string } };
		expect(saveResponse.status).toBe(200);
		expect(saved.file.content).toContain("careful-reviewer");
	});

	it("seeds, lists, and edits packaged Brain prompt templates", async () => {
		const statusResponse = await app.request("http://localhost/api/project-setup");
		const status = await statusResponse.json() as {
			templateFiles: Array<{ path: string; content: string; contentHash: string; format: string }>;
		};
		const prompt = status.templateFiles.find(
			(file) => file.path === ".coleo/src/brain/templates/arm-prompt-complete-task.jinja",
		);

		expect(statusResponse.status).toBe(200);
		expect(prompt?.format).toBe("jinja");
		expect(prompt?.content.length).toBeGreaterThan(0);

		const editedContent = `${prompt?.content ?? ""}\n{# Customized from setup #}\n`;
		const saveResponse = await app.request("http://localhost/api/project-setup/file", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				kind: "template",
				path: prompt?.path,
				content: editedContent,
				expectedHash: prompt?.contentHash,
			}),
		});
		const saved = await saveResponse.json() as { file: { format: string; content: string } };

		expect(saveResponse.status).toBe(200);
		expect(saved.file.format).toBe("jinja");
		expect(saved.file.content).toBe(editedContent);
		expect(await readFile(join(root, ".coleo", "src", "brain", "templates", "arm-prompt-complete-task.jinja"), "utf-8"))
			.toBe(editedContent);
	});

	it("preserves verbose context, adds checklist items, and leaves import to the Brain", async () => {
		const verbosePlan = `# Project Plan

We are building the first release for small engineering teams. It must preserve
their existing workflow and ship with clear operational documentation.
`;
		const response = await app.request("http://localhost/api/project-setup/prepare", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sourcePath: ".project/plan.md",
				content: verbosePlan,
				expectedHash: null,
			}),
		});
		const body = await response.json() as {
			taskCount: number;
			canonicalPlan: { content: string; contentHash: string };
		};

		expect(response.status).toBe(200);
		expect(body.taskCount).toBe(1);
		expect(body.canonicalPlan.content).toContain(verbosePlan.trimEnd());
		expect(body.canonicalPlan.content).toContain("- [ ] Build the first release");
		expect(await readFile(join(root, ".project", "plan.md"), "utf-8")).toBe(body.canonicalPlan.content);
		expect((db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count).toBe(0);

		const repeatedResponse = await app.request("http://localhost/api/project-setup/prepare", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sourcePath: ".project/plan.md",
				content: verbosePlan,
				expectedHash: body.canonicalPlan.contentHash,
			}),
		});
		const repeated = await repeatedResponse.json() as { taskCount: number };
		expect(repeatedResponse.status).toBe(200);
		expect(repeated.taskCount).toBe(1);
		expect((db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count).toBe(0);
	});

	it("rejects writes outside the plan directories", async () => {
		const response = await app.request("http://localhost/api/project-setup/file", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "src/index.ts", content: "nope" }),
		});

		expect(response.status).toBe(400);
	});
});
