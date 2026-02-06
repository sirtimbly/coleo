import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createTaskDiscussionsRoutes } from "../routes/task-discussions";
import { HttpError } from "../middleware/error";

interface DiscussionResponse {
  discussions: Array<{
    id: string;
    taskId: string;
    parentId?: string;
    content: string;
    authorType: "human" | "arm" | "brain";
    authorId: string;
    authorName?: string;
    client: "web" | "mail" | "mcp" | "cli";
    edited: boolean;
    deleted: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  totalCount: number;
}

interface CommentResponse {
  comment: {
    id: string;
    taskId: string;
    parentId?: string;
    content: string;
    authorType: string;
    authorId: string;
    authorName?: string;
    client: string;
    edited: boolean;
    deleted: boolean;
    createdAt: string;
    updatedAt: string;
  };
}

interface UnreadResponse {
  unreadCount: number;
}

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
      assigned_to TEXT,
      consensus_status TEXT DEFAULT 'pending',
      comment_count INTEGER DEFAULT 0,
      last_comment_at TEXT,
      progress INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      claimed_at TEXT,
      started_at TEXT,
      due_date TEXT,
      artifacts TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      parent_id TEXT REFERENCES task_comments(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      screenshot_path TEXT,
      author_type TEXT NOT NULL CHECK (author_type IN ('human', 'arm', 'brain')),
      author_id TEXT NOT NULL,
      author_name TEXT,
      client TEXT NOT NULL CHECK (client IN ('web', 'mail', 'mcp', 'cli')),
      edited INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_task_comments_task ON task_comments(task_id);
    CREATE INDEX idx_task_comments_parent ON task_comments(parent_id);

    CREATE TABLE task_comment_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_read_comment_id TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, user_id)
    );

    CREATE INDEX idx_task_comment_reads_task ON task_comment_reads(task_id);
    CREATE INDEX idx_task_comment_reads_user ON task_comment_reads(user_id);
  `);

  const now = new Date("2026-01-16T00:00:00Z").toISOString();
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
     VALUES (?, 'Sample Task', 'desc', 'pending', 'normal', 'manual', ?, ?)`,
    ["task-1", now, now]
  );

  return db;
}

describe("Task Discussions API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    const discussionsApp = createTaskDiscussionsRoutes();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/tasks/:id/discussions", discussionsApp);
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

  describe("GET /api/tasks/:id/discussions", () => {
    it("should return empty array for task with no discussions", async () => {
      const res = await app.request("/api/tasks/task-1/discussions");
      expect(res.status).toBe(200);
      const body = (await res.json()) as DiscussionResponse;
      expect(body.discussions).toEqual([]);
      expect(body.totalCount).toBe(0);
    });

    it("should return discussions ordered by created_at DESC", async () => {
      const now = new Date();

      // Create 3 comments
      for (let i = 0; i < 3; i++) {
        const createdAt = new Date(now.getTime() - i * 1000).toISOString();
        db.run(
          `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
           VALUES (?, 'task-1', ?, 'human', 'user-1', 'web', ?, ?)`,
          [`comment-${i}`, `Content ${i}`, createdAt, createdAt]
        );
      }

      const res = await app.request("/api/tasks/task-1/discussions");
      expect(res.status).toBe(200);
      const body = (await res.json()) as DiscussionResponse;
      expect(body.discussions.length).toBe(3);
      expect(body.discussions[0]?.content).toBe("Content 0");
      expect(body.discussions[1]?.content).toBe("Content 1");
      expect(body.discussions[2]?.content).toBe("Content 2");
    });

    it("should respect limit and offset", async () => {
      const now = new Date();

      // Create 5 comments
      for (let i = 0; i < 5; i++) {
        const createdAt = new Date(now.getTime() - i * 1000).toISOString();
        db.run(
          `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
           VALUES (?, 'task-1', ?, 'human', 'user-1', 'web', ?, ?)`,
          [`comment-${i}`, `Content ${i}`, createdAt, createdAt]
        );
      }

      const res = await app.request("/api/tasks/task-1/discussions?limit=2&offset=1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as DiscussionResponse;
      expect(body.discussions.length).toBe(2);
      expect(body.totalCount).toBe(5);
      expect(body.discussions[0]?.content).toBe("Content 1");
      expect(body.discussions[1]?.content).toBe("Content 2");
    });

    it("should return threaded structure when threaded=true", async () => {
      const now = new Date();

      // Create parent comment
      const parentId = "comment-parent";
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Parent', 'human', 'user-1', 'web', ?, ?)`,
        [parentId, now.toISOString(), now.toISOString()]
      );

      // Create 2 replies
      for (let i = 0; i < 2; i++) {
        const createdAt = new Date(now.getTime() + (i + 1) * 1000).toISOString();
        db.run(
          `INSERT INTO task_comments (id, task_id, parent_id, content, author_type, author_id, client, created_at, updated_at)
           VALUES (?, 'task-1', ?, ?, 'human', 'user-1', 'web', ?, ?)`,
          [`reply-${i}`, parentId, `Reply ${i}`, createdAt, createdAt]
        );
      }

      const res = await app.request("/api/tasks/task-1/discussions?threaded=true");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { discussions: Array<{ id: string; replies: unknown[] }>; totalCount: number };
      expect(body.discussions.length).toBe(1);
      expect(body.discussions[0]?.id).toBe(parentId);
      expect(body.discussions[0]?.replies.length).toBe(2);
    });

    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/api/tasks/nonexistent/discussions");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/tasks/:id/discussions", () => {
    it("should create a new comment", async () => {
      const res = await app.request("/api/tasks/task-1/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Test comment",
          authorType: "human",
          authorId: "user-1",
          client: "web",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as CommentResponse;
      expect(body.comment.content).toBe("Test comment");
      expect(body.comment.authorType).toBe("human");
      expect(body.comment.authorId).toBe("user-1");
      expect(body.comment.client).toBe("web");
      expect(body.comment.edited).toBe(false);
      expect(body.comment.deleted).toBe(false);
    });

    it("should update task comment_count and last_comment_at", async () => {
      await app.request("/api/tasks/task-1/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Test comment",
          authorType: "human",
          authorId: "user-1",
          client: "web",
        }),
      });

      const taskRow = db
        .query("SELECT comment_count, last_comment_at FROM tasks WHERE id = ?")
        .get("task-1") as { comment_count: number; last_comment_at: string };

      expect(taskRow.comment_count).toBe(1);
      expect(taskRow.last_comment_at).not.toBeNull();
    });

    it("should reject empty content", async () => {
      const res = await app.request("/api/tasks/task-1/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "",
          authorType: "human",
          authorId: "user-1",
          client: "web",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("should support replies with parentId", async () => {
      // First create a parent comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Parent', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["parent-comment"]
      );

      const res = await app.request("/api/tasks/task-1/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Reply comment",
          parentId: "parent-comment",
          authorType: "human",
          authorId: "user-1",
          client: "web",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as CommentResponse;
      expect(body.comment.parentId).toBe("parent-comment");
    });

    it("should reject invalid authorType", async () => {
      const res = await app.request("/api/tasks/task-1/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Test",
          authorType: "invalid",
          authorId: "user-1",
          client: "web",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject invalid client", async () => {
      const res = await app.request("/api/tasks/task-1/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Test",
          authorType: "human",
          authorId: "user-1",
          client: "invalid",
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/tasks/:id/discussions/:commentId", () => {
    it("should update comment content", async () => {
      // Create a comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Original', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Updated content",
          authorId: "user-1",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as CommentResponse;
      expect(body.comment.content).toBe("Updated content");
    });

    it("should set edited flag to true", async () => {
      // Create a comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Original', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Updated content",
          authorId: "user-1",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as CommentResponse;
      expect(body.comment.edited).toBe(true);
    });

    it("should reject edit after 24 hours", async () => {
      // Create a comment 25 hours ago
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Original', 'human', 'user-1', 'web', ?, ?)`,
        ["comment-1", oldDate, oldDate]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Updated content",
          authorId: "user-1",
        }),
      });

      expect(res.status).toBe(403);
    });

    it("should reject edit by non-author", async () => {
      // Create a comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Original', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Updated content",
          authorId: "user-2",
        }),
      });

      expect(res.status).toBe(403);
    });

    it("should reject edit of deleted comment", async () => {
      // Create a deleted comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, deleted, created_at, updated_at)
         VALUES (?, 'task-1', 'Original', 'human', 'user-1', 'web', 1, datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Updated content",
          authorId: "user-1",
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/tasks/:id/discussions/:commentId", () => {
    it("should soft delete comment", async () => {
      // Create a comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Content', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorId: "user-1",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean };
      expect(body.deleted).toBe(true);

      // Verify it's soft deleted
      const commentRow = db
        .query("SELECT deleted FROM task_comments WHERE id = ?")
        .get("comment-1") as { deleted: number };
      expect(commentRow.deleted).toBe(1);
    });

    it("should update task comment_count after delete", async () => {
      // Create a comment and update stats
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Content', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );
      db.run("UPDATE tasks SET comment_count = 1 WHERE id = 'task-1'");

      await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorId: "user-1",
        }),
      });

      const taskRow = db
        .query("SELECT comment_count FROM tasks WHERE id = ?")
        .get("task-1") as { comment_count: number };
      expect(taskRow.comment_count).toBe(0);
    });

    it("should reject delete by non-author", async () => {
      // Create a comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Content', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorId: "user-2",
        }),
      });

      expect(res.status).toBe(403);
    });

    it("should reject delete of already deleted comment", async () => {
      // Create a deleted comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, deleted, created_at, updated_at)
         VALUES (?, 'task-1', 'Content', 'human', 'user-1', 'web', 1, datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/comment-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorId: "user-1",
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/tasks/:id/discussions/mark-read", () => {
    it("should create read receipt", async () => {
      // Create a comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Content', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      const res = await app.request("/api/tasks/task-1/discussions/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          lastReadCommentId: "comment-1",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { marked: boolean };
      expect(body.marked).toBe(true);

      // Verify read receipt was created
      const readRow = db
        .query("SELECT * FROM task_comment_reads WHERE task_id = ? AND user_id = ?")
        .get("task-1", "user-1") as { last_read_comment_id: string };
      expect(readRow.last_read_comment_id).toBe("comment-1");
    });

    it("should update existing read receipt", async () => {
      // Create comments
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Content 1', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Content 2', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-2"]
      );

      // First read
      await app.request("/api/tasks/task-1/discussions/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          lastReadCommentId: "comment-1",
        }),
      });

      // Second read
      await app.request("/api/tasks/task-1/discussions/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          lastReadCommentId: "comment-2",
        }),
      });

      // Verify read receipt was updated
      const readRow = db
        .query("SELECT last_read_comment_id FROM task_comment_reads WHERE task_id = ? AND user_id = ?")
        .get("task-1", "user-1") as { last_read_comment_id: string };
      expect(readRow.last_read_comment_id).toBe("comment-2");
    });

    it("should reject invalid comment id", async () => {
      const res = await app.request("/api/tasks/task-1/discussions/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          lastReadCommentId: "nonexistent",
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/tasks/:id/discussions/unread", () => {
    it("should return unread count for new user", async () => {
      // Create comments
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
           VALUES (?, 'task-1', ?, 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
          [`comment-${i}`, `Content ${i}`]
        );
      }

      const res = await app.request("/api/tasks/task-1/discussions/unread?userId=user-2");
      expect(res.status).toBe(200);
      const body = (await res.json()) as UnreadResponse;
      expect(body.unreadCount).toBe(5);
    });

    it("should return 0 for user who has read all comments", async () => {
      // Create a comment
      db.run(
        `INSERT INTO task_comments (id, task_id, content, author_type, author_id, client, created_at, updated_at)
         VALUES (?, 'task-1', 'Content', 'human', 'user-1', 'web', datetime('now'), datetime('now'))`,
        ["comment-1"]
      );

      // Mark as read
      db.run(
        `INSERT INTO task_comment_reads (task_id, user_id, last_read_comment_id, read_at)
         VALUES ('task-1', 'user-1', 'comment-1', datetime('now'))`
      );

      const res = await app.request("/api/tasks/task-1/discussions/unread?userId=user-1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as UnreadResponse;
      expect(body.unreadCount).toBe(0);
    });

    it("should require userId parameter", async () => {
      const res = await app.request("/api/tasks/task-1/discussions/unread");
      expect(res.status).toBe(400);
    });
  });
});
