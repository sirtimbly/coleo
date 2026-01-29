import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createBugsRoutes, type Bug } from "../routes/bugs";
import { HttpError } from "../middleware/error";

// Test database setup
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE bugs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      source_arm_id TEXT,
      source_task_id TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assignee_arm_id TEXT,
      blockers TEXT DEFAULT '[]',
      error_details TEXT,
      resolution TEXT,
      sort_order INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      human_notified INTEGER DEFAULT 0
    );

    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      name TEXT
    );
  `);

  return db;
}

describe("bugs API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    const bugsApp = createBugsRoutes();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/bugs", bugsApp);
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

  describe("POST /api/bugs (create)", () => {
    it("should create a bug with valid title, description, and source", async () => {
      const response = await app.request("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Test Bug",
          description: "Test Description",
          source: "human_reported",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { bugId: string };
      expect(body.bugId).toBeDefined();

      // Verify by fetching the bug
      const getResponse = await app.request(`/api/bugs/${body.bugId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.title).toBe("Test Bug");
      expect(getBody.bug.description).toBe("Test Description");
      expect(getBody.bug.status).toBe("open");
      expect(getBody.bug.priority).toBe("medium");
      expect(getBody.bug.source).toBe("human_reported");
    });

    it("should reject missing required fields", async () => {
      const response = await app.request("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Only description", source: "human_reported" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Missing required fields");
    });

    it("should reject invalid source", async () => {
      const response = await app.request("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          title: "Test Bug", 
          description: "Test Description", 
          source: "invalid_source" 
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Invalid source");
    });

    it("should accept optional priority", async () => {
      const response = await app.request("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "High Priority Bug",
          description: "Critical issue",
          source: "human_reported",
          priority: "high",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { bugId: string };
      expect(body.bugId).toBeDefined();

      // Verify by fetching the bug
      const getResponse = await app.request(`/api/bugs/${body.bugId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.priority).toBe("high");
    });

    it("should accept optional metadata", async () => {
      const metadata = { ui: { tags: ["critical"], color: "red" } };
      const response = await app.request("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Metadata Bug",
          description: "Bug with metadata",
          source: "human_reported",
          metadata,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { bugId: string };
      expect(body.bugId).toBeDefined();

      // Verify by fetching the bug
      const getResponse = await app.request(`/api/bugs/${body.bugId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.metadata).toEqual(metadata);
    });
  });

  describe("GET /api/bugs (list)", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at)
        VALUES 
          ('bug-1', 'First Bug', 'Description 1', 'human_reported', 'open', 'high', 0, ?, ?),
          ('bug-2', 'Second Bug', 'Description 2', 'arm_reported', 'investigating', 'critical', 1, ?, ?),
          ('bug-3', 'Third Bug', 'Description 3', 'system_detected', 'resolved', 'low', 2, ?, ?)
      `, [now, now, now, now, now, now]);
    });

    it("should list all bugs", async () => {
      const response = await app.request("/api/bugs");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { bugs: Bug[] };
      expect(body.bugs).toHaveLength(3);
    });

    it("should filter by status", async () => {
      const response = await app.request("/api/bugs?status=open");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { bugs: Bug[] };
      expect(body.bugs).toHaveLength(1);
      expect(body.bugs[0]?.title).toBe("First Bug");
    });

    it("should filter by source", async () => {
      const response = await app.request("/api/bugs?source=arm_reported");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { bugs: Bug[] };
      expect(body.bugs).toHaveLength(1);
      expect(body.bugs[0]?.title).toBe("Second Bug");
    });

    it("should filter by priority", async () => {
      const response = await app.request("/api/bugs?priority=critical");
      expect(response.status).toBe(200);
      
      const body = await response.json() as { bugs: Bug[] };
      expect(body.bugs).toHaveLength(1);
      expect(body.bugs[0]?.title).toBe("Second Bug");
    });
  });

  describe("PATCH /api/bugs/:id (update)", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, metadata)
        VALUES ('bug-123', 'Original Title', 'Original Description', 'human_reported', 'open', 'medium', 0, ?, ?, '{}')
      `, [now, now]);
    });

    it("should update bug title", async () => {
      const response = await app.request("/api/bugs/bug-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated Title" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      // Verify update by fetching the bug
      const getResponse = await app.request("/api/bugs/bug-123");
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.title).toBe("Updated Title");
      expect(getBody.bug.description).toBe("Original Description"); // unchanged
    });

    it("should update bug status", async () => {
      const response = await app.request("/api/bugs/bug-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "investigating" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      // Verify update by fetching the bug
      const getResponse = await app.request("/api/bugs/bug-123");
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.status).toBe("investigating");
    });

    it("should update metadata", async () => {
      const response = await app.request("/api/bugs/bug-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { ui: { tags: ["urgent"] } } }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      // Verify update by fetching the bug
      const getResponse = await app.request("/api/bugs/bug-123");
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.metadata).toEqual({ ui: { tags: ["urgent"] } });
    });

    it("should return 404 for non-existent bug", async () => {
      const response = await app.request("/api/bugs/bug-999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Update" }),
      });

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Bug not found");
    });
  });

  describe("DELETE /api/bugs/:id", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at)
        VALUES ('bug-to-delete', 'Delete Me', 'Description', 'human_reported', 'open', 'medium', 0, ?, ?)
      `, [now, now]);
    });

    it("should delete a bug", async () => {
      const response = await app.request("/api/bugs/bug-to-delete", {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      // Verify bug is gone
      const getResponse = await app.request("/api/bugs/bug-to-delete");
      expect(getResponse.status).toBe(404);
    });

    it("should return 404 for non-existent bug", async () => {
      const response = await app.request("/api/bugs/bug-999", {
        method: "DELETE",
      });

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Bug not found");
    });
  });

  describe("POST /api/bugs/reorder", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at)
        VALUES 
          ('bug-a', 'Bug A', 'First', 'human_reported', 'open', 'medium', 0, ?, ?),
          ('bug-b', 'Bug B', 'Second', 'human_reported', 'open', 'medium', 1, ?, ?),
          ('bug-c', 'Bug C', 'Third', 'human_reported', 'open', 'medium', 2, ?, ?)
      `, [now, now, now, now, now, now]);
    });

    it("should move bug to specified position", async () => {
      const response = await app.request("/api/bugs/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bugId: "bug-c", toSortOrder: 0 }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      // Verify order changed in database
      const rows = db.query("SELECT id, sort_order FROM bugs ORDER BY sort_order ASC").all() as Array<{ id: string; sort_order: number }>;
      expect(rows[0]?.id).toBe("bug-c"); // Moved to position 0
      expect(rows[1]?.id).toBe("bug-a"); // Shifted down
      expect(rows[2]?.id).toBe("bug-b");
    });

    it("should return 404 for non-existent bug", async () => {
      const response = await app.request("/api/bugs/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bugId: "bug-999", toSortOrder: 0 }),
      });

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Bug not found");
    });
  });
});
