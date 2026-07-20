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
      human_notified INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0
    );

    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      name TEXT
    );

    CREATE VIRTUAL TABLE bugs_fts USING fts5(
      title,
      content='bugs',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER bugs_fts_ai AFTER INSERT ON bugs BEGIN
      INSERT INTO bugs_fts(rowid, title) VALUES (new.rowid, new.title);
    END;

    CREATE TRIGGER bugs_fts_ad AFTER DELETE ON bugs BEGIN
      INSERT INTO bugs_fts(bugs_fts, rowid, title) VALUES('delete', old.rowid, old.title);
    END;

    CREATE TRIGGER bugs_fts_au AFTER UPDATE ON bugs BEGIN
      INSERT INTO bugs_fts(bugs_fts, rowid, title) VALUES('delete', old.rowid, old.title);
      INSERT INTO bugs_fts(rowid, title) VALUES (new.rowid, new.title);
    END;

    INSERT INTO bugs_fts(bugs_fts) VALUES ('rebuild');
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

    it("should deduplicate similar bug titles using FTS candidates", async () => {
      const first = await app.request("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Infrastructure health issues detected: Database, NATS, Maildir unavailable",
          description: "first report",
          source: "human_reported",
        }),
      });

      expect(first.status).toBe(201);
      const firstBody = await first.json() as { bugId: string; deduplicated: boolean };
      expect(firstBody.deduplicated).toBe(false);

      const second = await app.request("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Infrastructure health issues: database and nats and maildir unavailable",
          description: "second report",
          source: "human_reported",
        }),
      });

      expect(second.status).toBe(200);
      const secondBody = await second.json() as { bugId: string; deduplicated: boolean };
      expect(secondBody.deduplicated).toBe(true);
      expect(secondBody.bugId).toBe(firstBody.bugId);

      const bugCount = db.query("SELECT COUNT(*) as count FROM bugs").get() as { count: number };
      expect(bugCount.count).toBe(1);
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

  describe("GET /api/bugs/stats", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, archived)
        VALUES
          ('bug-stats-open', 'Open Bug', 'Description', 'arm_reported', 'open', 'high', 0, ?, ?, 0),
          ('bug-stats-investigating', 'Investigating Bug', 'Description', 'human_reported', 'investigating', 'medium', 1, ?, ?, 0),
          ('bug-stats-resolved', 'Resolved Bug', 'Description', 'system_detected', 'resolved', 'low', 2, ?, ?, 0),
          ('bug-stats-archived-open', 'Archived Open', 'Description', 'human_reported', 'open', 'low', 3, ?, ?, 1)
      `, [now, now, now, now, now, now, now, now]);
    });

    it("should return aggregated counts for non-archived bugs", async () => {
      const response = await app.request("/api/bugs/stats");
      expect(response.status).toBe(200);

      const body = await response.json() as {
        bySource: Record<string, number>;
        byStatus: Record<string, number>;
        byPriority: Record<string, number>;
        recent24h: number;
        unresolved: number;
      };

      expect(body.bySource).toEqual({
        arm_reported: 1,
        human_reported: 1,
        system_detected: 1,
      });
      expect(body.byStatus).toEqual({
        open: 1,
        investigating: 1,
        resolved: 1,
      });
      expect(body.byPriority).toEqual({
        high: 1,
        medium: 1,
        low: 1,
      });
      expect(body.recent24h).toBe(3);
      expect(body.unresolved).toBe(2);
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

    it("should handle title with single quotes", async () => {
      const title = "Can't edit bug with single quotes in title";
      const response = await app.request("/api/bugs/bug-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      const getResponse = await app.request("/api/bugs/bug-123");
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.title).toBe(title);
    });

    it("should handle description with double quotes and newlines", async () => {
      const description = "Error message: \"Something went wrong\"\nStack trace:\n- Line 1\n- Line 2";
      const response = await app.request("/api/bugs/bug-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      const getResponse = await app.request("/api/bugs/bug-123");
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.description).toBe(description);
    });

    it("should handle title with backslashes and special characters", async () => {
      const title = "Path C:\\Users\\Test <script>alert('xss')</script>";
      const response = await app.request("/api/bugs/bug-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);

      const getResponse = await app.request("/api/bugs/bug-123");
      const getBody = await getResponse.json() as { bug: Bug };
      expect(getBody.bug.title).toBe(title);
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

  describe("POST /api/bugs/:id/archive", () => {
    it("should archive a resolved bug", async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, archived)
        VALUES ('bug-resolved', 'Resolved Bug', 'Description', 'arm_reported', 'resolved', 'medium', 0, ?, ?, 0)
      `, [now, now]);

      const response = await app.request("/api/bugs/bug-resolved/archive", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; archived: boolean };
      expect(body.success).toBe(true);
      expect(body.archived).toBe(true);

      // Verify bug is archived in DB
      const row = db.query("SELECT archived FROM bugs WHERE id = ?").get("bug-resolved") as { archived: number };
      expect(row.archived).toBe(1);
    });

    it("should not archive an open bug", async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, archived)
        VALUES ('bug-open', 'Open Bug', 'Description', 'arm_reported', 'open', 'medium', 0, ?, ?, 0)
      `, [now, now]);

      const response = await app.request("/api/bugs/bug-open/archive", {
        method: "POST",
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("Only resolved or closed bugs can be archived");
    });

    it("should return 404 for non-existent bug", async () => {
      const response = await app.request("/api/bugs/bug-999/archive", {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/bugs/:id/unarchive", () => {
    it("should unarchive an archived bug", async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, archived)
        VALUES ('bug-archived', 'Archived Bug', 'Description', 'arm_reported', 'resolved', 'medium', 0, ?, ?, 1)
      `, [now, now]);

      const response = await app.request("/api/bugs/bug-archived/unarchive", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; archived: boolean };
      expect(body.success).toBe(true);
      expect(body.archived).toBe(false);

      // Verify bug is unarchived in DB
      const row = db.query("SELECT archived FROM bugs WHERE id = ?").get("bug-archived") as { archived: number };
      expect(row.archived).toBe(0);
    });

    it("should return 404 for non-existent bug", async () => {
      const response = await app.request("/api/bugs/bug-999/unarchive", {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/bugs with archived filter", () => {
    it("should filter out archived bugs by default", async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, archived)
        VALUES 
          ('bug-active', 'Active Bug', 'Description', 'arm_reported', 'open', 'medium', 0, ?, ?, 0),
          ('bug-archived-filter', 'Archived Bug', 'Description', 'arm_reported', 'resolved', 'medium', 1, ?, ?, 1)
      `, [now, now, now, now]);

      const response = await app.request("/api/bugs");
      expect(response.status).toBe(200);

      const body = await response.json() as { bugs: Bug[] };
      const bugIds = body.bugs.map(b => b.id);
      expect(bugIds).toContain("bug-active");
      expect(bugIds).not.toContain("bug-archived-filter");
    });

    it("should show archived bugs when archived=true", async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, archived)
        VALUES 
          ('bug-active-2', 'Active Bug 2', 'Description', 'arm_reported', 'open', 'medium', 0, ?, ?, 0),
          ('bug-archived-filter-2', 'Archived Bug 2', 'Description', 'arm_reported', 'resolved', 'medium', 1, ?, ?, 1)
      `, [now, now, now, now]);

      const response = await app.request("/api/bugs?archived=true");
      expect(response.status).toBe(200);

      const body = await response.json() as { bugs: Bug[] };
      const bugIds = body.bugs.map(b => b.id);
      expect(bugIds).not.toContain("bug-active-2");
      expect(bugIds).toContain("bug-archived-filter-2");
    });

    it("should show non-archived bugs when archived=false", async () => {
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO bugs (id, title, description, source, status, priority, sort_order, created_at, updated_at, archived)
        VALUES 
          ('bug-active-3', 'Active Bug 3', 'Description', 'arm_reported', 'open', 'medium', 0, ?, ?, 0),
          ('bug-archived-filter-3', 'Archived Bug 3', 'Description', 'arm_reported', 'resolved', 'medium', 1, ?, ?, 1)
      `, [now, now, now, now]);

      const response = await app.request("/api/bugs?archived=false");
      expect(response.status).toBe(200);

      const body = await response.json() as { bugs: Bug[] };
      const bugIds = body.bugs.map(b => b.id);
      expect(bugIds).toContain("bug-active-3");
      expect(bugIds).not.toContain("bug-archived-filter-3");
    });
  });
});
