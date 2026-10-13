import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createTasksRoutes, type Task } from "../routes/tasks";
import { createTaskDiscussionsRoutes } from "../routes/task-discussions";
import { HttpError } from "../middleware/error";

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
      consensus_status TEXT DEFAULT 'pending',
      plan_line_uid TEXT,
      sort_order INTEGER DEFAULT 0,
      order_key TEXT,
      comment_count INTEGER DEFAULT 0,
      last_comment_at TEXT,
      mail_thread_id TEXT,
      progress INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      claimed_at TEXT,
      started_at TEXT,
      blocked_at TEXT,
      blocked_reason TEXT,
      blocked_category TEXT,
      blocked_recheck_at TEXT,
      blocked_last_checked_at TEXT,
      blocked_review_count INTEGER NOT NULL DEFAULT 0,
      blocked_needs_human INTEGER NOT NULL DEFAULT 0,
      blocked_human_notified_at TEXT,
      blocked_review_arm_id TEXT,
      blocked_review_started_at TEXT,
      due_date TEXT,
      artifacts TEXT DEFAULT '[]',
      context TEXT DEFAULT '{}',
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      parent_id TEXT,
      content TEXT NOT NULL,
      screenshot_path TEXT,
      author_type TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT,
      client TEXT NOT NULL,
      edited INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
	return db;
}

async function createTask(
	app: Hono<{ Variables: { db: Database } }>,
	subject: string,
	description: string,
): Promise<Task> {
	const response = await app.request("/api/tasks", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subject, description }),
	});
	const body = (await response.json()) as { task: Task };
	return body.task;
}

async function addComment(
	app: Hono<{ Variables: { db: Database } }>,
	taskId: string,
	content: string,
	authorType = "human",
): Promise<void> {
	const response = await app.request(`/api/tasks/${taskId}/discussions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			content,
			authorType,
			authorId: "user-1",
			authorName: "Test User",
			client: "web",
		}),
	});
	expect(response.status).toBe(201);
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe("POST /api/tasks/:id/prepare", () => {
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;

	beforeEach(() => {
		db = createTestDb();
		const tasksApp = createTasksRoutes();
		const discussionsApp = createTaskDiscussionsRoutes();
		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			return next();
		});
		app.route("/api/tasks", tasksApp);
		app.route("/api/tasks/:id/discussions", discussionsApp);
		app.onError((err, c) => {
			if (err instanceof HttpError) {
				return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 500);
			}
			console.error("Unexpected error:", err);
			return c.json({ error: "Internal server error" }, 500);
		});
	});

	afterEach(() => {
		db.close();
	});

	it("returns a fallback definition when no brain API key is configured", async () => {
		const originalApiKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;

		const task = await createTask(app, "Build feature", "We need a feature");
		await addComment(app, task.id, "Use React for the UI");

		const response = await app.request(`/api/tasks/${task.id}/prepare`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { prepared: { subject: string; description: string } };
		expect(body.prepared.subject).toBe("Build feature");
		expect(body.prepared.description).toContain("We need a feature");

		if (originalApiKey !== undefined) {
			process.env.OPENAI_API_KEY = originalApiKey;
		}
	});

	it("calls the configured LLM and parses the returned JSON", async () => {
		process.env.OPENAI_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "https://api.test.example.com/v1";

		const task = await createTask(app, "Build feature", "We need a feature");
		await addComment(app, task.id, "Use React for the UI");

		const mockFetch: FetchLike = async (_input, init) => {
			const body = init?.body ? JSON.parse(init.body as string) : {};
			expect(body.model).toBeDefined();
			expect(body.messages[1].content).toContain("Use React for the UI");

			return Response.json({
				choices: [
					{
						message: {
							content: JSON.stringify({
								subject: "Implement React-based feature UI",
								description: "Build the user interface using React components.",
								context: "Existing discussion points toward React.",
								requirements: ["Create component files", "Wire up state"],
								acceptanceCriteria: ["UI renders without errors"],
								priority: "high",
								classification: "development",
								phase: "mvp",
								estimatedEffort: "2-3 hours",
							}),
						},
					},
				],
			});
		};

		const { prepareTaskFromDiscussion } = await import("../services/task-preparation");
		const prepared = await prepareTaskFromDiscussion(db, task, {
			fetchFn: mockFetch as typeof fetch,
		});

		expect(prepared.subject).toBe("Implement React-based feature UI");
		expect(prepared.requirements).toEqual(["Create component files", "Wire up state"]);
		expect(prepared.priority).toBe("high");

		delete process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_BASE_URL;
	});

	it("returns 404 for a missing task", async () => {
		const response = await app.request("/api/tasks/nonexistent/prepare", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(404);
	});
});
