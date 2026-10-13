import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { initDatabase } from "../../db";
import { createTasksRoutes } from "../routes/tasks";
import { HttpError } from "../middleware/error";
import { prepareTaskForHandoff } from "../../mcp/tools/prepare-task";
import { activatePreparedTaskHandoffs } from "../../brain/task-handoffs";

describe("task handoff queue", () => {
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY, subject TEXT NOT NULL, description TEXT NOT NULL,
				status TEXT NOT NULL, priority TEXT NOT NULL, source_type TEXT, source_ref TEXT,
				phase TEXT, domain TEXT, classification TEXT, assigned_to TEXT,
				dependency_blocked INTEGER DEFAULT 0, consensus_status TEXT, plan_line_uid TEXT,
				sort_order INTEGER DEFAULT 0, order_key TEXT, comment_count INTEGER DEFAULT 0,
				last_comment_at TEXT, mail_thread_id TEXT, progress INTEGER DEFAULT 0,
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
				claimed_at TEXT, started_at TEXT, blocked_at TEXT, blocked_reason TEXT,
				blocked_category TEXT, blocked_recheck_at TEXT, blocked_last_checked_at TEXT,
				blocked_review_count INTEGER DEFAULT 0, blocked_needs_human INTEGER DEFAULT 0,
				blocked_human_notified_at TEXT, blocked_review_arm_id TEXT,
				blocked_review_started_at TEXT, due_date TEXT, artifacts TEXT DEFAULT '[]',
				context TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}',
				prepared_by_arm_id TEXT, prepared_at TEXT
			);
			CREATE TABLE task_dependencies (task_id TEXT, depends_on_task_id TEXT);
			CREATE TABLE task_handoffs (
				id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
				prepared_by TEXT, prepared_at TEXT NOT NULL, queued_at TEXT NOT NULL,
				activated_at TEXT, payload TEXT NOT NULL DEFAULT '{}'
			);
		`);
		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => { c.set("db", db); return next(); });
		app.route("/api/tasks", createTasksRoutes());
		app.onError((error, c) => error instanceof HttpError
			? c.json({ error: error.message }, error.status as 400 | 404 | 409 | 500)
			: c.json({ error: "Internal server error" }, 500));
	});

	afterEach(() => db.close());

	async function createDraft(): Promise<string> {
		const now = new Date().toISOString();
		db.run(`INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at)
			VALUES ('draft-1', 'Prepared work', 'Details', 'draft', 'normal', ?, ?)`, [now, now]);
		return "draft-1";
	}

	const preparation = {
		subject: "Prepared work", description: "Implement the plan's next step", priority: "normal" as const,
		sourceRef: ".project/plan.md#prepared-work", acceptanceCriteria: ["works"],
		dependencies: [] as string[], context: "Plan context", outputs: ["src/feature.ts"],
	};

	async function request<T>(path: string, options?: RequestInit): Promise<T | null> {
		const response = await app.request(path, options);
		return response.ok ? await response.json() as T : null;
	}

	it("prepares through MCP and lets the Brain activate only after dependencies complete", async () => {
		const dependencyId = await createDraft();
		const result = await prepareTaskForHandoff({ ...preparation, dependencies: [dependencyId] }, {
			baseUrl: "http://coleo.test", apiKey: "test-key", armId: "architect-1",
			fetchFn: ((url: string | URL | Request, options?: RequestInit) => {
				expect(new Headers(options?.headers).get("X-API-Key")).toBe("test-key");
				return app.request(String(url), options);
			}) as typeof fetch,
		});
		const task = db.query("SELECT status, source_ref, prepared_by_arm_id, context FROM tasks WHERE id = ?")
			.get(result.task.id) as { status: string; source_ref: string; prepared_by_arm_id: string; context: string };
		expect(task.status).toBe("draft");
		expect(task.source_ref).toBe(preparation.sourceRef);
		expect(task.prepared_by_arm_id).toBe("architect-1");
		expect(JSON.parse(task.context).acceptanceCriteria).toEqual(["works"]);
		expect(db.query("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?").get(result.task.id))
			.toEqual({ depends_on_task_id: dependencyId });
		await activatePreparedTaskHandoffs(request, () => {});
		expect(db.query("SELECT status FROM task_handoffs WHERE id = ?").get(result.handoff.id)).toEqual({ status: "queued" });
		expect(db.query("SELECT status FROM tasks WHERE id = ?").get(result.task.id)).toEqual({ status: "draft" });
		db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [dependencyId]);
		await activatePreparedTaskHandoffs(request, () => {});
		expect(db.query("SELECT status FROM tasks WHERE id = ?").get(result.task.id)).toEqual({ status: "pending" });
		expect(db.query("SELECT status FROM task_handoffs WHERE id = ?").get(result.handoff.id)).toEqual({ status: "activated" });
		await activatePreparedTaskHandoffs(request, () => {});
		expect(db.query("SELECT COUNT(*) AS count FROM task_handoffs").get()).toEqual({ count: 1 });
	});

	it("rejects incomplete MCP metadata and unknown dependencies without creating orphan tasks", async () => {
		for (const input of [{ subject: "Incomplete" }, { ...preparation, dependencies: ["missing-task"] }]) {
			const response = await app.request("/api/tasks/prepared", {
				method: "POST", body: JSON.stringify({ ...input, preparedBy: "architect-1" }),
			});
			expect(response.status).toBe(400);
		}
		expect(db.query("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
		expect(db.query("SELECT COUNT(*) AS count FROM task_handoffs").get()).toEqual({ count: 0 });
	});

	it("rolls preparation back if inserting the handoff fails", async () => {
		db.exec("CREATE TRIGGER reject_handoff BEFORE INSERT ON task_handoffs BEGIN SELECT RAISE(ABORT, 'failure'); END;");
		const response = await app.request("/api/tasks/prepared", {
			method: "POST", body: JSON.stringify({ ...preparation, preparedBy: "architect-1" }),
		});
		expect(response.status).toBe(500);
		expect(db.query("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
	});

	it("queues a draft without making it eligible and is idempotent", async () => {
		const taskId = await createDraft();
		const first = await app.request(`/api/tasks/${taskId}/handoff`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preparedBy: "architect-1", prepared: {
				sourceRef: ".project/plan.md#prepared-work", acceptanceCriteria: ["works"],
				dependencies: [], context: "Plan context", outputs: ["feature files"],
			} }),
		});
		expect(first.status).toBe(202);
		expect((db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status).toBe("draft");
		const second = await app.request(`/api/tasks/${taskId}/handoff`, { method: "POST", body: "{}" });
		expect(second.status).toBe(200);
		expect((db.query("SELECT COUNT(*) AS count FROM task_handoffs").get() as { count: number }).count).toBe(1);
	});

	it("activates only when dependencies are complete", async () => {
		const taskId = await createDraft();
		const now = new Date().toISOString();
		db.run(`INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at)
			VALUES ('dependency-1', 'Dependency', 'Details', 'in_progress', 'normal', ?, ?)`, [now, now]);
		db.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", [taskId, "dependency-1"]);
		const queued = await app.request(`/api/tasks/${taskId}/handoff`, { method: "POST", body: JSON.stringify({ prepared: {
			sourceRef: ".project/plan.md#prepared-work", acceptanceCriteria: ["works"],
			dependencies: ["dependency-1"], context: "Plan context", outputs: ["feature files"],
		} }) });
		const queuedBody = await queued.json() as { handoff: { id: string } };
		const blocked = await app.request(`/api/tasks/handoff/${queuedBody.handoff.id}/activate`, { method: "POST" });
		expect(blocked.status).toBe(409);
		db.run("UPDATE tasks SET status = 'completed' WHERE id = 'dependency-1'");
		const activated = await app.request(`/api/tasks/handoff/${queuedBody.handoff.id}/activate`, { method: "POST" });
		expect(activated.status).toBe(200);
		expect((db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status).toBe("pending");
	});

	it("keeps incomplete preparation out of the executable queue", async () => {
		const taskId = await createDraft();
		const queued = await app.request(`/api/tasks/${taskId}/handoff`, {
			method: "POST",
			body: JSON.stringify({ prepared: { acceptanceCriteria: ["works"] } }),
		});
		const body = await queued.json() as { handoff: { id: string } };
		const response = await app.request(`/api/tasks/handoff/${body.handoff.id}/activate`, { method: "POST" });
		expect(response.status).toBe(409);
		expect((db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status).toBe("draft");
		const repaired = await app.request(`/api/tasks/${taskId}/handoff`, {
			method: "POST", body: JSON.stringify({ prepared: preparation }),
		});
		expect(repaired.status).toBe(200);
		expect((await repaired.json() as { handoff: { id: string } }).handoff.id).toBe(body.handoff.id);
		await activatePreparedTaskHandoffs(request, () => {});
		expect(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "pending" });
	});

	it("prepares and activates against the complete migration schema", async () => {
		const migrated = await initDatabase(":memory:");
		try {
			const realApp = new Hono<{ Variables: { db: Database } }>();
			realApp.use("*", async (c, next) => { c.set("db", migrated); return next(); });
			realApp.route("/api/tasks", createTasksRoutes());
			const prepared = await realApp.request("/api/tasks/prepared", {
				method: "POST", body: JSON.stringify({ ...preparation, preparedBy: "architect-1" }),
			});
			expect(prepared.status).toBe(201);
			const body = await prepared.json() as { task: { id: string }; handoff: { id: string } };
			const activated = await realApp.request(`/api/tasks/handoff/${body.handoff.id}/activate`, { method: "POST" });
			expect(activated.status).toBe(200);
			expect(migrated.query("SELECT status FROM tasks WHERE id = ?").get(body.task.id)).toEqual({ status: "pending" });
		} finally { migrated.close(); }
	});

	it("keeps missing payload dependencies queued without stalling later ready handoffs", async () => {
		const taskId = await createDraft();
		const queued = await app.request(`/api/tasks/${taskId}/handoff`, {
			method: "POST", body: JSON.stringify({ prepared: { ...preparation, dependencies: ["unknown-plan-reference"] } }),
		});
		expect(queued.status).toBe(202);
		const ready = await app.request("/api/tasks/prepared", {
			method: "POST", body: JSON.stringify({ ...preparation, preparedBy: "architect-1" }),
		});
		const body = await ready.json() as { task: { id: string } };
		await activatePreparedTaskHandoffs(request, () => {});
		expect(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "draft" });
		expect(db.query("SELECT status FROM tasks WHERE id = ?").get(body.task.id)).toEqual({ status: "pending" });
	});

	for (const status of ["cancelled", "pending"]) {
		it(`does not activate tasks made ${status} after queueing`, async () => {
			const taskId = await createDraft();
			const queued = await app.request(`/api/tasks/${taskId}/handoff`, {
				method: "POST", body: JSON.stringify({ prepared: preparation }),
			});
			const body = await queued.json() as { handoff: { id: string } };
			db.run("UPDATE tasks SET status = ? WHERE id = ?", [status, taskId]);
			const activated = await app.request(`/api/tasks/handoff/${body.handoff.id}/activate`, { method: "POST" });
			expect(activated.status).toBe(409);
			expect(db.query("SELECT status FROM task_handoffs WHERE id = ?").get(body.handoff.id)).toEqual({ status: "queued" });
		});
	}

	it("rejects pending tasks instead of bypassing preparation and dependency checks", async () => {
		const taskId = await createDraft();
		db.run("UPDATE tasks SET status = 'pending' WHERE id = ?", [taskId]);
		for (const prepared of [{}, { ...preparation, dependencies: ["missing-dependency"] }]) {
			const response = await app.request(`/api/tasks/${taskId}/handoff`, {
				method: "POST", body: JSON.stringify({ prepared }),
			});
			expect(response.status).toBe(400);
		}
		expect(db.query("SELECT COUNT(*) AS count FROM task_handoffs").get()).toEqual({ count: 0 });
		expect(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "pending" });
	});
});
