import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { parsePlanFile } from "../../brain/plan-parser";
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
			order_key TEXT,
			plan_line_uid TEXT,
			tags TEXT DEFAULT '[]',
			metadata TEXT DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		);
		CREATE TABLE arms (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			current_task_id TEXT,
			current_task_subject TEXT
		);
		CREATE TABLE arm_state_machine (
			arm_id TEXT PRIMARY KEY,
			state TEXT NOT NULL,
			current_task_id TEXT,
			current_task_subject TEXT
		);
	`);
	return db;
}

describe("project setup routes", () => {
	let root: string;
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;
	let formatterGuidance: string | undefined;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "coleo-project-setup-api-"));
		db = createTestDb();
		formatterGuidance = undefined;
		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});
		app.onError((error, c) => formatErrorResponse(c, error));
		app.route("/api/project-setup", createProjectSetupRoutes({
			workspace: new LocalWorkspaceAccess(root),
			coleoDir: join(root, ".coleo"),
			formatter: async (content, _sourcePath, guidance) => {
				formatterGuidance = guidance;
				return {
				mode: "structured",
				content: content.includes("### Deliverables")
					? content
					: `${content.trimEnd()}\n\n## Phase 1: Launch\n\n### Deliverables\n\n- [ ] Build the first release\n`,
				};
			},
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

	it("requires an explanation before regenerating tasks", async () => {
		const response = await app.request("http://localhost/api/project-setup/regenerate-tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ explanation: "" }),
		});

		expect(response.status).toBe(400);
	});

	it("preserves completed tasks and regenerates every other task with human guidance", async () => {
		const canonicalPlan = `# Project Plan

## Phase 1: Launch

### Deliverables

- [ ] Build the replacement queue
- [ ] Verify the replacement queue
`;
		await mkdir(join(root, ".project"), { recursive: true });
		await writeFile(join(root, ".project", "plan.md"), canonicalPlan);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
			 VALUES ('completed-task', 'Keep me', '', 'completed', 'normal', 'manual', ?, ?)`,
			[now, now],
		);
		db.run(
			`INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
			 VALUES ('stale-task', 'Delete me', '', 'pending', 'normal', 'manual', ?, ?)`,
			[now, now],
		);
		db.run(
			`INSERT INTO arms (id, status, current_task_id, current_task_subject)
			 VALUES ('idle-arm', 'idle', 'stale-task', 'Delete me')`,
		);
		db.run(
			`INSERT INTO arm_state_machine (arm_id, state, current_task_id, current_task_subject)
			 VALUES ('idle-arm', 'idle', 'stale-task', 'Delete me')`,
		);

		const response = await app.request("http://localhost/api/project-setup/regenerate-tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ explanation: "The old tasks were duplicated; create clean, broader units." }),
		});
		const body = await response.json() as { deletedCount: number; createdCount: number };
		const tasks = db
			.query("SELECT subject, status, metadata FROM tasks ORDER BY subject")
			.all() as Array<{ subject: string; status: string; metadata: string }>;

		expect(response.status).toBe(200);
		expect(body.deletedCount).toBe(1);
		expect(body.createdCount).toBe(2);
		expect(formatterGuidance).toBe("The old tasks were duplicated; create clean, broader units.");
		expect(tasks.map((task) => task.subject)).toEqual([
			"Build the replacement queue",
			"Keep me",
			"Verify the replacement queue",
		]);
		expect(tasks.find((task) => task.subject === "Keep me")?.status).toBe("completed");
		expect(tasks.find((task) => task.subject === "Build the replacement queue")?.metadata)
			.toContain("clean, broader units");
		expect(db.query("SELECT current_task_id, current_task_subject FROM arms WHERE id = 'idle-arm'").get())
			.toEqual({ current_task_id: null, current_task_subject: null });
		expect(db.query("SELECT current_task_id, current_task_subject FROM arm_state_machine WHERE arm_id = 'idle-arm'").get())
			.toEqual({ current_task_id: null, current_task_subject: null });
	});

	it("refuses to regenerate while an arm is working on a deletable task", async () => {
		await mkdir(join(root, ".project"), { recursive: true });
		await writeFile(
			join(root, ".project", "plan.md"),
			"# Project Plan\n\n## Phase 1: Launch\n\n### Deliverables\n\n- [ ] Build the replacement queue\n",
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
			 VALUES ('active-task', 'Active work', '', 'in_progress', 'normal', 'manual', ?, ?)`,
			[now, now],
		);
		db.run(
			`INSERT INTO arms (id, status, current_task_id, current_task_subject)
			 VALUES ('active-arm', 'busy', 'active-task', 'Active work')`,
		);

		const response = await app.request("http://localhost/api/project-setup/regenerate-tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ explanation: "Rebuild the queue with broader tasks." }),
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Stop all arms working on active tasks");
		expect((db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count).toBe(1);
	});

	it("refuses to delete work claimed while the plan formatter is running", async () => {
		await mkdir(join(root, ".project"), { recursive: true });
		await writeFile(
			join(root, ".project", "plan.md"),
			"# Project Plan\n\n## Phase 1: Launch\n\n### Deliverables\n\n- [ ] Build the replacement queue\n",
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
			 VALUES ('claimed-during-format', 'Claimed work', '', 'pending', 'normal', 'manual', ?, ?)`,
			[now, now],
		);

		const formatter = async (content: string) => {
			db.run("UPDATE tasks SET status = 'in_progress', assigned_to = 'late-arm' WHERE id = 'claimed-during-format'");
			db.run(
				`INSERT INTO arms (id, status, current_task_id, current_task_subject)
				 VALUES ('late-arm', 'busy', 'claimed-during-format', 'Claimed work')`,
			);
			return { mode: "structured" as const, content };
		};
		const raceApp = new Hono<{ Variables: { db: Database } }>();
		raceApp.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});
		raceApp.onError((error, c) => formatErrorResponse(c, error));
		raceApp.route("/api/project-setup", createProjectSetupRoutes({
			workspace: new LocalWorkspaceAccess(root),
			coleoDir: join(root, ".coleo"),
			formatter,
		}));

		const response = await raceApp.request("http://localhost/api/project-setup/regenerate-tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ explanation: "Rebuild the queue with broader tasks." }),
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Stop all arms working on active tasks");
		expect(db.query("SELECT status, assigned_to FROM tasks WHERE id = 'claimed-during-format'").get())
			.toEqual({ status: "in_progress", assigned_to: "late-arm" });
	});

	it("does not recreate a plan task that already exists as completed", async () => {
		const workspace = new LocalWorkspaceAccess(root);
		await mkdir(join(root, ".project"), { recursive: true });
		await writeFile(
			join(root, ".project", "plan.md"),
			"# Project Plan\n\n## Phase 1: Launch\n\n### Deliverables\n\n- [ ] Keep the completed queue migration\n",
		);
		const parsed = await parsePlanFile(".project/plan.md", workspace);
		const completedTask = parsed.tasks[0]!;
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at, completed_at)
			 VALUES (?, ?, '', 'completed', 'normal', 'plan', ?, ?, ?)`,
			[completedTask.id, completedTask.subject, now, now, now],
		);

		const response = await app.request("http://localhost/api/project-setup/regenerate-tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ explanation: "Rebuild the remaining queue." }),
		});
		const body = await response.json() as { createdCount: number; preservedCompletedCount: number };

		expect(response.status).toBe(200);
		expect(body.createdCount).toBe(0);
		expect(body.preservedCompletedCount).toBe(1);
		expect((db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count).toBe(1);
	});

	it("assigns distinct IDs when different plan tasks share the same ID prefix", async () => {
		const sharedPrefix = "Implement the complete regeneration workflow with safeguards ";
		await mkdir(join(root, ".project"), { recursive: true });
		await writeFile(
			join(root, ".project", "plan.md"),
			`# Project Plan\n\n## Phase 1: Launch\n\n### Deliverables\n\n- [ ] ${sharedPrefix}for the API\n- [ ] ${sharedPrefix}for the web UI\n`,
		);

		const response = await app.request("http://localhost/api/project-setup/regenerate-tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ explanation: "Keep both distinct deliverables." }),
		});
		const body = await response.json() as { createdCount: number };
		const ids = db.query("SELECT id FROM tasks ORDER BY subject").all() as Array<{ id: string }>;

		expect(response.status).toBe(200);
		expect(body.createdCount).toBe(2);
		expect(new Set(ids.map((task) => task.id)).size).toBe(2);
	});
});
