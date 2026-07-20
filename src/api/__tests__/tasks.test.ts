import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createTasksRoutes, type Task } from "../routes/tasks";
import { HttpError } from "../middleware/error";

// Test database setup
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

    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'idle',
      current_task_id TEXT,
      current_task_subject TEXT,
      updated_at TEXT
    );

    CREATE TABLE task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL
    );

    CREATE TABLE task_arm_consensus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      approval TEXT,
      approval_reason TEXT,
      last_report TEXT,
      last_report_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  return db;
}

describe("tasks API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    const tasksApp = createTasksRoutes();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/tasks", tasksApp);
    // Register error handler to catch HttpError instances
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

  describe("POST /api/tasks (create)", () => {
    it("should create a task with valid subject and description", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Test Task",
          description: "Test Description",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { task: Task };
      expect(body.task).toBeDefined();
      expect(body.task.id).toBe("task-1");
      expect(body.task.subject).toBe("Test Task");
      expect(body.task.description).toBe("Test Description");
      expect(body.task.status).toBe("pending");
      expect(body.task.priority).toBe("normal");
      expect(body.task.sortOrder).toBe(0);
    });

    it("should assign sequential IDs (task-1, task-2, task-3)", async () => {
      // Create first task
      const res1 = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Task 1", description: "Desc 1" }),
      });
      const body1 = await res1.json() as { task: Task };
      expect(body1.task.id).toBe("task-1");

      // Create second task
      const res2 = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Task 2", description: "Desc 2" }),
      });
      const body2 = await res2.json() as { task: Task };
      expect(body2.task.id).toBe("task-2");

      // Create third task
      const res3 = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Task 3", description: "Desc 3" }),
      });
      const body3 = await res3.json() as { task: Task };
      expect(body3.task.id).toBe("task-3");
    });

    it("should assign order_key for fractional indexing", async () => {
      // Create first task
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Task 1", description: "Desc 1" }),
      });

      // Create second task
      const res2 = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Task 2", description: "Desc 2" }),
      });
      const body2 = await res2.json() as { task: Task };
      expect(body2.task.orderKey).toBeDefined();
      expect(body2.task.orderKey).toBe("b");

      // Create third task
      const res3 = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Task 3", description: "Desc 3" }),
      });
      const body3 = await res3.json() as { task: Task };
      expect(body3.task.orderKey).toBeDefined();
      expect(body3.task.orderKey).toBe("c");
    });

    it("should reject missing subject", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Only description" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("subject is required");
    });

    it("should reject empty subject", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "   ", description: "Has description" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("subject is required");
    });

    it("should reject missing description", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Only subject" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("description is required");
    });

    it("should reject empty description", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Has subject", description: "   " }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("description is required");
    });

    it("should accept optional priority", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "High Priority Task",
          description: "Important task",
          priority: "high",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { task: Task };
      expect(body.task.priority).toBe("high");
    });

    it("should accept optional domain", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Domain Task",
          description: "Task with domain",
          domain: "backend",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { task: Task };
      expect(body.task.domain).toBe("backend");
    });

    it("should accept optional phase", async () => {
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Phase Task",
          description: "Task with phase",
          phase: "design",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { task: Task };
      expect(body.task.phase).toBe("design");
    });

    it("should accept optional metadata", async () => {
      const metadata = { ui: { tags: ["urgent"], color: "red" } };
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Metadata Task",
          description: "Task with metadata",
          metadata,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { task: Task };
      expect(body.task.metadata).toEqual(metadata);
    });

    it("should set timestamps on creation", async () => {
      const before = new Date().toISOString();
      
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Timestamp Task",
          description: "Check timestamps",
        }),
      });

      const after = new Date().toISOString();
      expect(response.status).toBe(201);
      const body = await response.json() as { task: Task };
      
      expect(body.task.createdAt).toBeDefined();
      expect(body.task.updatedAt).toBeDefined();
      expect(body.task.createdAt).toBe(body.task.updatedAt);
      expect(body.task.createdAt >= before).toBe(true);
      expect(body.task.createdAt <= after).toBe(true);
    });

    it("should treat duplicate provided task IDs as idempotent", async () => {
      const first = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "task-fixed-id",
          subject: "Original Subject",
          description: "Original Description",
          priority: "high",
        }),
      });
      expect(first.status).toBe(201);

      const second = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "task-fixed-id",
          subject: "Different Subject",
          description: "Different Description",
          priority: "low",
        }),
      });

      expect(second.status).toBe(200);
      const secondBody = await second.json() as { task: Task };
      expect(secondBody.task.id).toBe("task-fixed-id");
      expect(secondBody.task.subject).toBe("Original Subject");
      expect(secondBody.task.description).toBe("Original Description");
      expect(secondBody.task.priority).toBe("high");

      const rowCount = db
        .query("SELECT COUNT(*) as count FROM tasks WHERE id = ?")
        .get("task-fixed-id") as { count: number } | null;
      expect(rowCount?.count).toBe(1);
    });
  });

  describe("GET /api/tasks (list)", () => {
    beforeEach(async () => {
      // Create some test tasks with order_key for fractional indexing
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, source_type, order_key, created_at, updated_at)
        VALUES 
          ('task-1', 'First Task', 'Description 1', 'pending', 'normal', 'manual', 'a', ?, ?),
          ('task-2', 'Second Task', 'Description 2', 'in_progress', 'high', 'manual', 'b', ?, ?),
          ('task-3', 'Third Task', 'Description 3', 'completed', 'low', 'manual', 'c', ?, ?)
      `, [now, now, now, now, now, now]);
    });

    it("should list all tasks", async () => {
      const response = await app.request("/api/tasks");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { tasks: Task[]; pagination: { total: number }; counts: { total: number } };
      expect(body.tasks).toHaveLength(3);
      expect(body.pagination.total).toBe(3);
      expect(body.counts.total).toBe(3);
    });

    it("should return counts by status", async () => {
      const response = await app.request("/api/tasks");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { counts: { byStatus: Record<string, number> } };
      expect(body.counts.byStatus.pending).toBe(1);
      expect(body.counts.byStatus.in_progress).toBe(1);
      expect(body.counts.byStatus.completed).toBe(1);
    });

    it("should filter by status", async () => {
      const response = await app.request("/api/tasks?status=pending");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { tasks: Task[] };
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]?.id).toBe("task-1");
    });

    it("should filter by multiple statuses", async () => {
      const response = await app.request("/api/tasks?status=pending,in_progress");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { tasks: Task[] };
      expect(body.tasks).toHaveLength(2);
    });

    it("should filter by priority", async () => {
      const response = await app.request("/api/tasks?priority=high");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { tasks: Task[] };
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]?.id).toBe("task-2");
    });

    it("should support pagination with limit and offset", async () => {
      const response = await app.request("/api/tasks?limit=1&offset=0");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { tasks: Task[]; pagination: { limit: number; offset: number; total: number } };
      expect(body.tasks).toHaveLength(1);
      expect(body.pagination.limit).toBe(1);
      expect(body.pagination.offset).toBe(0);
      expect(body.pagination.total).toBe(3);
    });

    it("should sort by order_key ascending", async () => {
      const response = await app.request("/api/tasks");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { tasks: Task[] };
      expect(body.tasks[0]?.id).toBe("task-1");
      expect(body.tasks[1]?.id).toBe("task-2");
      expect(body.tasks[2]?.id).toBe("task-3");
    });
  });

  describe("GET /api/tasks/:id", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, source_type, sort_order, created_at, updated_at, metadata)
        VALUES ('task-123', 'Single Task', 'A single task', 'pending', 'normal', 'manual', 0, ?, ?, '{"custom": "data"}')
      `, [now, now]);
    });

    it("should return a task by ID", async () => {
      const response = await app.request("/api/tasks/task-123");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { task: Task; dependencies: string[] };
      expect(body.task).toBeDefined();
      expect(body.task.id).toBe("task-123");
      expect(body.task.subject).toBe("Single Task");
      expect(body.task.description).toBe("A single task");
      expect(body.task.metadata).toEqual({ custom: "data" });
      expect(body.dependencies).toEqual([]);
    });

    it("should return 404 for non-existent task", async () => {
      const response = await app.request("/api/tasks/task-999");
      expect(response.status).toBe(404);
      
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Task not found");
    });
  });

  describe("PATCH /api/tasks/:id (update)", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, source_type, sort_order, created_at, updated_at, metadata)
        VALUES ('task-123', 'Original Subject', 'Original Description', 'pending', 'normal', 'manual', 0, ?, ?, '{}')
      `, [now, now]);
    });

    it("should update task subject", async () => {
      const response = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Updated Subject" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { task: Task };
      expect(body.task.subject).toBe("Updated Subject");
      expect(body.task.description).toBe("Original Description"); // unchanged
    });

    it("should handle subject with single quotes", async () => {
      const subject = "Can't edit task with single quotes in subject";
      const response = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { task: Task };
      expect(body.task.subject).toBe(subject);
    });

    it("should handle description with double quotes and newlines", async () => {
      const description = "Error: \"Something failed\"\nDetails:\n- Item 1\n- Item 2";
      const response = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { task: Task };
      expect(body.task.description).toBe(description);
    });

    it("should handle subject with special characters and backslashes", async () => {
      const subject = "Path C:\\Users\\Test <script>alert('xss')</script>";
      const response = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { task: Task };
      expect(body.task.subject).toBe(subject);
    });

    it("should update task status and set timestamps", async () => {
      // Update to claimed
      const claimedRes = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "claimed" }),
      });

       expect(claimedRes.status).toBe(200);
       const claimedBody = await claimedRes.json() as { task: Task };
       expect(claimedBody.task.status).toBe("claimed");
		expect(claimedBody.task.claimedAt).not.toBeNull();

      // Update to in_progress
      const progressRes = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });

       expect(progressRes.status).toBe(200);
       const progressBody = await progressRes.json() as { task: Task };
       expect(progressBody.task.status).toBe("in_progress");
		expect(progressBody.task.startedAt).not.toBeNull();

      // Update to completed
      const completedRes = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });

       expect(completedRes.status).toBe(200);
       const completedBody = await completedRes.json() as { task: Task };
       expect(completedBody.task.status).toBe("completed");
		expect(completedBody.task.completedAt).not.toBeNull();
     });

		it("requires a reason and sets blocked review state across transitions", async () => {
			const missingReasonRes = await app.request("/api/tasks/task-123", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "blocked" }),
			});
			expect(missingReasonRes.status).toBe(400);

			const blockedRes = await app.request("/api/tasks/task-123", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					status: "blocked",
					blockedReason: "Waiting for production credentials",
					blockedCategory: "human",
					blockedNeedsHuman: true,
				}),
			});

			expect(blockedRes.status).toBe(200);
			const blockedBody = (await blockedRes.json()) as { task: Task };
			expect(blockedBody.task.blockedAt).not.toBeNull();
			expect(blockedBody.task.blockedReason).toBe("Waiting for production credentials");
			expect(blockedBody.task.blockedCategory).toBe("human");
			expect(blockedBody.task.blockedNeedsHuman).toBe(true);
			expect(blockedBody.task.blockedRecheckAt).not.toBeNull();

			const resumedRes = await app.request("/api/tasks/task-123", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "in_progress" }),
			});

			expect(resumedRes.status).toBe(200);
			const resumedBody = (await resumedRes.json()) as { task: Task };
			expect(resumedBody.task.blockedAt).toBeNull();
			expect(resumedBody.task.blockedReason).toBeNull();
			expect(resumedBody.task.startedAt).not.toBeNull();
		});

		it("rejects creating a blocked task without a reason", async () => {
			const response = await app.request("/api/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					subject: "Blocked task",
					description: "Cannot proceed",
					status: "blocked",
				}),
			});

			expect(response.status).toBe(400);
		});

		it("releases an assignment when manually returning a task to pending", async () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO arms (id, name, status, current_task_id, current_task_subject, updated_at)
				 VALUES ('arm-1', 'Arm 1', 'busy', 'task-123', 'Original Subject', ?)`,
				[now],
			);
			db.run("UPDATE tasks SET status = 'in_progress', assigned_to = 'arm-1' WHERE id = 'task-123'");

			const response = await app.request("/api/tasks/task-123", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "pending" }),
			});

			expect(response.status).toBe(200);
			const taskRow = db.query("SELECT assigned_to FROM tasks WHERE id = 'task-123'").get() as {
				assigned_to: string | null;
			};
			const armRow = db.query("SELECT status, current_task_id FROM arms WHERE id = 'arm-1'").get() as {
				status: string;
				current_task_id: string | null;
			};
			expect(taskRow.assigned_to).toBeNull();
			expect(armRow).toEqual({ status: "idle", current_task_id: null });
		});

    it("should update metadata", async () => {
      const response = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { ui: { tags: ["bug"] } } }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { task: Task };
      expect(body.task.metadata).toEqual({ ui: { tags: ["bug"] } });
    });

    it("should return 404 for non-existent task", async () => {
      const response = await app.request("/api/tasks/task-999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Update" }),
      });

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Task not found");
    });

    it("should reject update with no fields", async () => {
      const response = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("No fields to update");
    });

    it("should update updated_at timestamp", async () => {
      const original = db.query("SELECT updated_at FROM tasks WHERE id = 'task-123'").get() as { updated_at: string };
      
      // Small delay to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      const response = await app.request("/api/tasks/task-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Updated" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { task: Task };
      expect(body.task.updatedAt).not.toBe(original.updated_at);
    });
  });

  describe("DELETE /api/tasks/:id", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, source_type, sort_order, created_at, updated_at)
        VALUES ('task-to-delete', 'Delete Me', 'Description', 'pending', 'normal', 'manual', 0, ?, ?)
      `, [now, now]);
    });

    it("should delete a task", async () => {
      const response = await app.request("/api/tasks/task-to-delete", {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { deleted: boolean };
      expect(body.deleted).toBe(true);

      // Verify task is gone
      const getResponse = await app.request("/api/tasks/task-to-delete");
      expect(getResponse.status).toBe(404);
    });

    it("should return 404 for non-existent task", async () => {
      const response = await app.request("/api/tasks/task-999", {
        method: "DELETE",
      });

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Task not found");
    });
  });

  describe("GET /api/tasks/burndown", () => {
    beforeEach(() => {
      db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, source_type, domain, created_at, updated_at, completed_at)
        VALUES
          ('burndown-a', 'Created', 'Created task', 'completed', 'normal', 'manual', 'backend', '2026-01-01T10:15:00.000Z', '2026-01-01T10:15:00.000Z', '2026-01-02T11:00:00.000Z'),
          ('burndown-b', 'Other domain', 'Other task', 'pending', 'normal', 'manual', 'frontend', '2026-01-02T10:30:00.000Z', '2026-01-02T10:30:00.000Z', NULL)
      `);
    });

    it("groups created and completed tasks by user-local day and applies filters", async () => {
      const response = await app.request(
        "/api/tasks/burndown?start=2026-01-01T00:00:00.000Z&end=2026-01-03T00:00:00.000Z&bin=day&timeZone=America/New_York&domain=backend",
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        buckets: Array<{ bucket: string; created: number; completed: number; cumulativeCreated: number; cumulativeCompleted: number }>;
      };
      expect(body.buckets).toEqual([
        { bucket: "2026-01-01", created: 1, completed: 0, cumulativeCreated: 1, cumulativeCompleted: 0 },
        { bucket: "2026-01-02", created: 0, completed: 1, cumulativeCreated: 1, cumulativeCompleted: 1 },
      ]);
    });

    it("rejects invalid timezone and oversized hourly ranges", async () => {
      const badTimezone = await app.request(
        "/api/tasks/burndown?start=2026-01-01T00:00:00.000Z&end=2026-01-02T00:00:00.000Z&timeZone=Not/AZone",
      );
      expect(badTimezone.status).toBe(400);

      const oversized = await app.request(
        "/api/tasks/burndown?start=2026-01-01T00:00:00.000Z&end=2026-02-02T00:00:00.000Z&bin=hour",
      );
      expect(oversized.status).toBe(400);
    });
  });

  describe("POST /api/tasks/reorder", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, source_type, order_key, created_at, updated_at)
        VALUES 
          ('task-a', 'Task A', 'First', 'pending', 'normal', 'manual', 'a', ?, ?),
          ('task-b', 'Task B', 'Second', 'pending', 'normal', 'manual', 'b', ?, ?),
          ('task-c', 'Task C', 'Third', 'pending', 'normal', 'manual', 'c', ?, ?),
          ('task-d', 'Task D', 'Fourth', 'pending', 'normal', 'manual', 'd', ?, ?)
      `, [now, now, now, now, now, now, now, now]);
    });

    it("should move task to specified position using toIndex", async () => {
      const response = await app.request("/api/tasks/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "task-d", toIndex: 0 }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; orderKey: string };
      expect(body.success).toBe(true);
      expect(body.orderKey).toBeDefined();

      // Verify order changed in database
      const rows = db.query("SELECT id, order_key FROM tasks ORDER BY order_key ASC").all() as Array<{ id: string; order_key: string }>;
      expect(rows[0]?.id).toBe("task-d"); // Moved to position 0
      expect(rows[1]?.id).toBe("task-a"); // Shifted down
      expect(rows[2]?.id).toBe("task-b");
      expect(rows[3]?.id).toBe("task-c");

      // sort_order is deprecated; ordering is driven by order_key.
      const movedTask = rows.find((row) => row.id === "task-d");
      expect(movedTask?.order_key).toBeDefined();
    });

    it("should move task using prevTaskId and nextTaskId", async () => {
      // Move task-d between task-a and task-b
      const response = await app.request("/api/tasks/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "task-d", prevTaskId: "task-a", nextTaskId: "task-b" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; orderKey: string };
      expect(body.success).toBe(true);
      expect(body.orderKey).toBeDefined();

      // Verify order changed in database
      const rows = db.query("SELECT id, order_key FROM tasks ORDER BY order_key ASC").all() as Array<{ id: string; order_key: string }>;
      expect(rows[0]?.id).toBe("task-a");
      expect(rows[1]?.id).toBe("task-d"); // Moved between a and b
      expect(rows[2]?.id).toBe("task-b");
      expect(rows[3]?.id).toBe("task-c");
    });

    it("should move task to end with -1", async () => {
      const response = await app.request("/api/tasks/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "task-a", toIndex: -1 }),
      });

      expect(response.status).toBe(200);

      // Verify order
      const rows = db.query("SELECT id, order_key FROM tasks ORDER BY order_key ASC").all() as Array<{ id: string; order_key: string }>;
      expect(rows[0]?.id).toBe("task-b");
      expect(rows[1]?.id).toBe("task-c");
      expect(rows[2]?.id).toBe("task-d");
      expect(rows[3]?.id).toBe("task-a"); // Moved to end
    });

    it("should return 404 for non-existent task", async () => {
      const response = await app.request("/api/tasks/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "task-999", toIndex: 0 }),
      });

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Task not found");
    });
  });
});
