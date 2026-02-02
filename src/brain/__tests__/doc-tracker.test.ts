/**
 * DocUpdateTracker Tests
 * 
 * Tests for the documentation update tracking functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DocUpdateTracker } from "../doc-tracker";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";

describe("DocUpdateTracker", () => {
  let db: Database;
  let tracker: DocUpdateTracker;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const coleoDir = join(testDir, ".coleo");
    
    await mkdir(join(coleoDir, "db"), { recursive: true });
    
    db = new Database(join(coleoDir, "test.db"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      
      INSERT OR IGNORE INTO config (key, value) VALUES
        ('doc_update_file_threshold', '10'),
        ('doc_update_poll_interval', '10'),
        ('doc_update_enabled', 'true');

      CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        content_hash TEXT,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        detected_by_arm_id TEXT
      );

      CREATE TABLE IF NOT EXISTS doc_updates (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('phase_complete', 'threshold', 'human_request', 'periodic')),
        files_reviewed INTEGER DEFAULT 0,
        docs_updated INTEGER DEFAULT 0,
        future_work_notes_added INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        metadata TEXT DEFAULT '{}'
      );
    `);

    tracker = new DocUpdateTracker(db, coleoDir, testDir);
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getLastDocUpdateTime", () => {
    it("returns null when no doc updates exist", async () => {
      const result = await tracker.getLastDocUpdateTime();
      expect(result).toBeNull();
    });

    it("returns the completion time of the most recent completed update", async () => {
      db.run(`
        INSERT INTO doc_updates (id, task_id, trigger_type, status, started_at, completed_at)
        VALUES ('doc-1', 'task-1', 'threshold', 'completed', '2026-01-15T10:00:00Z', '2026-01-15T10:30:00Z')
      `);
      
      const result = await tracker.getLastDocUpdateTime();
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe("2026-01-15T10:30:00.000Z");
    });

    it("ignores in-progress updates", async () => {
      db.run(`
        INSERT INTO doc_updates (id, task_id, trigger_type, status, started_at)
        VALUES ('doc-1', 'task-1', 'threshold', 'in_progress', '2026-01-15T10:00:00Z')
      `);
      
      const result = await tracker.getLastDocUpdateTime();
      expect(result).toBeNull();
    });
  });

  describe("countChangedFilesSince", () => {
    it("returns 0 when no files changed", async () => {
      const since = new Date("2026-01-01T00:00:00Z");
      const result = await tracker.countChangedFilesSince(since);
      expect(result).toBe(0);
    });

    it("counts files changed after the given time", async () => {
      db.run(`
        INSERT INTO file_changes (file_path, change_type, changed_at)
        VALUES 
          ('src/a.ts', 'modified', '2026-01-15T10:00:00Z'),
          ('src/b.ts', 'modified', '2026-01-15T11:00:00Z'),
          ('src/c.ts', 'created', '2026-01-15T12:00:00Z')
      `);
      
      const since = new Date("2026-01-15T09:00:00Z");
      const result = await tracker.countChangedFilesSince(since);
      expect(result).toBe(3);
    });
  });

  describe("getChangedFilesSince", () => {
    it("returns empty array when no files changed", async () => {
      const since = new Date("2026-01-01T00:00:00Z");
      const result = await tracker.getChangedFilesSince(since);
      expect(result).toEqual([]);
    });

    it("returns list of changed files sorted by time descending", async () => {
      db.run(`
        INSERT INTO file_changes (file_path, change_type, changed_at)
        VALUES 
          ('src/a.ts', 'modified', '2026-01-15T10:00:00Z'),
          ('src/b.ts', 'modified', '2026-01-15T11:00:00Z'),
          ('src/c.ts', 'created', '2026-01-15T12:00:00Z')
      `);
      
      const since = new Date("2026-01-15T09:00:00Z");
      const result = await tracker.getChangedFilesSince(since);
      expect(result).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]);
    });
  });

  describe("checkDocUpdateTrigger", () => {
    it("returns null when doc updates are disabled", async () => {
      db.run(`UPDATE config SET value = 'false' WHERE key = 'doc_update_enabled'`);
      
      const result = await tracker.checkDocUpdateTrigger();
      expect(result).toBeNull();
    });

    it("returns null when no previous update exists", async () => {
      const result = await tracker.checkDocUpdateTrigger();
      expect(result).toBeNull();
    });

    it("returns threshold trigger when enough files changed", async () => {
      // Insert 10 files (threshold is 10)
      const stmt = db.prepare(`
        INSERT INTO file_changes (file_path, change_type, changed_at)
        VALUES (?, 'modified', '2026-01-15T10:00:00Z')
      `);
      for (let i = 0; i < 10; i++) {
        stmt.run(`src/file${i}.ts`);
      }
      
      db.run(`
        INSERT INTO doc_updates (id, task_id, trigger_type, status, started_at, completed_at)
        VALUES ('doc-1', 'task-1', 'threshold', 'completed', '2026-01-15T09:00:00Z', '2026-01-15T09:30:00Z')
      `);
      
      const result = await tracker.checkDocUpdateTrigger();
      expect(result).not.toBeNull();
      expect(result!.trigger).toBe("threshold");
      expect(result!.reason).toContain("10 files changed");
    });
  });

  describe("createDocUpdate", () => {
    it("creates a new doc update record", async () => {
      const id = await tracker.createDocUpdate("task-123", "threshold");
      
      expect(id).toMatch(/^doc-\d+-[a-z0-9]+$/);
      
      const result = db.query(`SELECT * FROM doc_updates WHERE id = ?`).get(id) as Record<string, unknown>;
      expect(result).not.toBeNull();
      expect(result.task_id).toBe("task-123");
      expect(result.trigger_type).toBe("threshold");
      expect(result.status).toBe("pending");
    });
  });

  describe("startDocUpdate", () => {
    it("updates status to in_progress", async () => {
      const id = await tracker.createDocUpdate("task-123", "threshold");
      
      tracker.startDocUpdate(id);
      
      const result = db.query(`SELECT status FROM doc_updates WHERE id = ?`).get(id) as { status: string };
      expect(result.status).toBe("in_progress");
    });
  });

  describe("completeDocUpdate", () => {
    it("updates status to completed with stats", async () => {
      const id = await tracker.createDocUpdate("task-123", "threshold");
      tracker.startDocUpdate(id);
      
      tracker.completeDocUpdate(id, 15, 3, 2);
      
      const result = db.query(`SELECT * FROM doc_updates WHERE id = ?`).get(id) as Record<string, unknown>;
      expect(result.status).toBe("completed");
      expect(result.files_reviewed).toBe(15);
      expect(result.docs_updated).toBe(3);
      expect(result.future_work_notes_added).toBe(2);
      expect(result.completed_at).not.toBeNull();
    });
  });

  describe("getRecentDocUpdates", () => {
    it("returns empty array when no updates", () => {
      const result = tracker.getRecentDocUpdates(10);
      expect(result).toEqual([]);
    });

    it("returns recent updates sorted by start time", () => {
      db.run(`
        INSERT INTO doc_updates (id, task_id, trigger_type, status, started_at)
        VALUES 
          ('doc-1', 'task-1', 'periodic', 'completed', '2026-01-15T10:00:00Z'),
          ('doc-2', 'task-2', 'threshold', 'in_progress', '2026-01-15T11:00:00Z'),
          ('doc-3', 'task-3', 'human_request', 'pending', '2026-01-15T12:00:00Z')
      `);
      
      const result = tracker.getRecentDocUpdates(10);
      expect(result.length).toBe(3);
      expect(result[0]?.triggerType).toBe("human_request");
      expect(result[1]?.triggerType).toBe("threshold");
      expect(result[2]?.triggerType).toBe("periodic");
    });

    it("limits results by count", () => {
      db.run(`
        INSERT INTO doc_updates (id, task_id, trigger_type, status, started_at)
        VALUES 
          ('doc-1', 'task-1', 'periodic', 'completed', '2026-01-15T10:00:00Z'),
          ('doc-2', 'task-2', 'threshold', 'completed', '2026-01-15T11:00:00Z'),
          ('doc-3', 'task-3', 'human_request', 'completed', '2026-01-15T12:00:00Z')
      `);
      
      const result = tracker.getRecentDocUpdates(2);
      expect(result.length).toBe(2);
    });
  });

  describe("generateFutureWorkNote", () => {
    it("generates a complete future work note", () => {
      const note = tracker.generateFutureWorkNote("OAuth2 Authentication", "Implement OAuth2 provider with GitHub and Google", "Phase 3");
      
      expect(note).toContain("## OAuth2 Authentication");
      expect(note).toContain("**Status**: Planned for Phase 3");
      expect(note).toContain("**Details**: Implement OAuth2 provider with GitHub and Google");
      expect(note).toContain("not yet implemented");
    });

    it("handles missing phase gracefully", () => {
      const note = tracker.generateFutureWorkNote("Feature X", "Description here");
      
      expect(note).toContain("**Status**: Planned");
      expect(note).not.toContain("Phase");
    });
  });

  describe("generatePartialImplementationNote", () => {
    it("generates a partial implementation note", () => {
      const note = tracker.generatePartialImplementationNote(
        "User API",
        ["GET /users", "POST /users"],
        ["PUT /users/:id", "DELETE /users/:id"]
      );
      
      expect(note).toContain("## User API");
      expect(note).toContain("**Status**: Partial Implementation");
      expect(note).toContain("**Implemented**: GET /users, POST /users");
      expect(note).toContain("**Pending**: PUT /users/:id, DELETE /users/:id");
    });
  });
});
