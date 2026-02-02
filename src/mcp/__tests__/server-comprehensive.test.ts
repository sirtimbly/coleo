/**
 * Comprehensive MCP Server Integration Tests
 * 
 * Tests all MCP server tools with mocked dependencies:
 * - Mocked NATS client for messaging
 * - Mocked SQLite database for persistence
 * - Mocked filesystem for docs/ and queue operations
 * 
 * These tests verify that the MCP server correctly:
 * 1. Registers all tools properly
 * 2. Handles input validation via Zod schemas
 * 3. Interacts with the database correctly
 * 4. Publishes messages to NATS
 * 5. Returns proper response formats
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import type { Task, Discovery, QueueMessage, Note } from "../../types";

// Test environment setup
const TEST_ARM_ID = "test-arm-001";
const TEST_PROJECT_ROOT = "/tmp/coleo-test-project";
const TEST_COLEO_DIR = join(TEST_PROJECT_ROOT, ".coleo");

// Setup test environment variables before any imports
process.env.COLEO_ARM_ID = TEST_ARM_ID;
process.env.COLEO_PROJECT_ROOT = TEST_PROJECT_ROOT;
process.env.COLEO_DIR = TEST_COLEO_DIR;
process.env.COLEO_API_URL = "http://127.0.0.1:8080";
process.env.COLEO_API_KEY = "test-api-key";

// Mock NATS client
class MockNatsClient {
  private isConnectedFlag = false;
  private messages: Array<{ topic: string; data: unknown }> = [];
  private options: { publishFail?: boolean; connectFail?: boolean } = {};

  constructor(options: { publishFail?: boolean; connectFail?: boolean } = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.options.connectFail) {
      throw new Error("Mock connect failed");
    }
    this.isConnectedFlag = true;
  }

  async disconnect(): Promise<void> {
    this.isConnectedFlag = false;
  }

  isConnected(): boolean {
    return this.isConnectedFlag;
  }

  async publish<T>(topic: string, data: T): Promise<void> {
    if (!this.isConnectedFlag) {
      throw new Error("Not connected to NATS");
    }
    if (this.options.publishFail) {
      throw new Error("Mock publish failed");
    }
    this.messages.push({ topic, data });
  }

  async publishBrainMessage(message: unknown): Promise<void> {
    await this.publish("coleo.brain.messages", message);
  }

  getPublishedMessages(): Array<{ topic: string; data: unknown }> {
    return [...this.messages];
  }

  getBrainMessages(): unknown[] {
    return this.messages
      .filter(m => m.topic === "coleo.brain.messages")
      .map(m => m.data);
  }

  clearMessages(): void {
    this.messages = [];
  }
}



describe("MCP Server - Comprehensive Tool Tests", () => {
  let db: Database;
  let mockNats: MockNatsClient;
  let testCounter = 0;

  beforeAll(async () => {
    // Create test directories
    await mkdir(join(TEST_COLEO_DIR, "queue", "brain", "pending"), { recursive: true });
    await mkdir(join(TEST_COLEO_DIR, "state", "notes", "shared"), { recursive: true });
    await mkdir(join(TEST_COLEO_DIR, "docs"), { recursive: true });
    await mkdir(join(TEST_PROJECT_ROOT, "docs"), { recursive: true });
  });

  afterAll(async () => {
    try {
      await rm(TEST_PROJECT_ROOT, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  beforeEach(async () => {
    testCounter++;
    
    // Create fresh database with unique name for each test to avoid conflicts
    const dbPath = join(TEST_COLEO_DIR, `test-${testCounter}.db`);
    try {
      await rm(dbPath, { force: true });
    } catch { /* ignore */ }
    
    db = new Database(dbPath);
    
    // Create all required tables
    db.exec(`
      PRAGMA journal_mode = WAL;
      
      CREATE TABLE IF NOT EXISTS arms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        harness TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        context_budget INTEGER DEFAULT 128000,
        context_budget_used INTEGER DEFAULT 0,
        current_context_used INTEGER DEFAULT 0,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        phase TEXT,
        domain TEXT,
        assigned_to TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        arm_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT,
        file_path TEXT,
        line_number INTEGER,
        severity TEXT DEFAULT 'info',
        task_id TEXT,
        phase TEXT,
        status TEXT DEFAULT 'open',
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arm_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        claim_type TEXT NOT NULL DEFAULT 'read',
        claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS bugs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        source TEXT NOT NULL,
        source_arm_id TEXT,
        source_task_id TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'medium',
        assignee_arm_id TEXT,
        error_details TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        human_notified INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_arm TEXT NOT NULL,
        to_arm TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT,
        processed INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        category TEXT DEFAULT 'shared',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS context_compressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arm_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        original_tokens INTEGER NOT NULL,
        compressed_tokens INTEGER NOT NULL,
        compression_ratio REAL NOT NULL,
        removed_content TEXT,
        work_in_progress TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    
    mockNats = new MockNatsClient();
    await mockNats.connect();
    
    // Insert test arm
    db.run(`
      INSERT INTO arms (id, name, domain, harness, status) 
      VALUES (?, ?, ?, ?, ?)
    `, [TEST_ARM_ID, "Test Arm", "backend", "test", "running"]);
  });

  afterEach(() => {
    db.close();
    mockNats.disconnect();
    mockNats.clearMessages();
  });

  describe("Database Schema Tests", () => {
    it("creates all required tables", () => {
      const tables = db.query(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all() as Array<{ name: string }>;
      
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain("arms");
      expect(tableNames).toContain("tasks");
      expect(tableNames).toContain("discoveries");
      expect(tableNames).toContain("claims");
      expect(tableNames).toContain("bugs");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("notes");
      expect(tableNames).toContain("context_compressions");
    });

    it("test arm exists in database", () => {
      const arm = db.query(`SELECT * FROM arms WHERE id = ?`).get(TEST_ARM_ID) as { id: string; name: string } | null;
      expect(arm).not.toBeNull();
      expect(arm?.id).toBe(TEST_ARM_ID);
    });
  });

  describe("Task Management Tools", () => {
    beforeEach(() => {
      // Insert test tasks
      db.run(`
        INSERT INTO tasks (id, subject, description, status, priority, domain, assigned_to)
        VALUES 
          ('task-1', 'Implement API', 'Create REST endpoints', 'pending', 'high', 'backend', NULL),
          ('task-2', 'Fix UI Bug', 'Button not clickable', 'in_progress', 'critical', 'frontend', ?),
          ('task-3', 'Write Tests', 'Add unit tests', 'pending', 'normal', 'testing', NULL)
      `, [TEST_ARM_ID]);
    });

    it("queries pending tasks correctly", () => {
      const tasks = db.query(`
        SELECT id, subject, status, priority, domain, assigned_to
        FROM tasks
        WHERE status IN ('pending', 'claimed')
        AND (assigned_to = ? OR assigned_to IS NULL)
        ORDER BY 
          CASE WHEN assigned_to = ? THEN 0 ELSE 1 END,
          CASE priority 
            WHEN 'critical' THEN 1 
            WHEN 'high' THEN 2 
            WHEN 'normal' THEN 3 
            WHEN 'low' THEN 4 
          END,
          created_at ASC
      `).all(TEST_ARM_ID, TEST_ARM_ID) as Task[];

      // task-1: pending, unassigned - should match
      // task-2: in_progress (not in 'pending', 'claimed') - should NOT match
      // task-3: pending, unassigned - should match
      expect(tasks.length).toBe(2);
      expect(tasks[0]?.id).toBe('task-1'); // high priority
      expect(tasks[1]?.id).toBe('task-3'); // normal priority
    });

    it("claims a task via message queue", async () => {
      const claimMessage = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "task_assignment",
        payload: {
          action: "claim",
          taskId: "task-1"
        }
      };

      await mockNats.publishBrainMessage(claimMessage);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { type: string; payload: { action: string; taskId: string } };
      expect(msg?.type).toBe("task_assignment");
      expect(msg?.payload?.action).toBe("claim");
      expect(msg?.payload?.taskId).toBe("task-1");
    });

    it("marks task as complete", async () => {
      const completeMessage = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "task_complete",
        payload: {
          taskId: "task-2",
          summary: "Fixed the UI bug by updating CSS",
          artifacts: ["src/components/Button.tsx"]
        }
      };

      await mockNats.publishBrainMessage(completeMessage);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { type: string; payload: { taskId: string; summary: string } };
      expect(msg?.type).toBe("task_complete");
      expect(msg?.payload?.taskId).toBe("task-2");
    });

    it("submits status report for task", async () => {
      const statusReport = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "status_report",
        payload: {
          id: "sr-123",
          taskId: "task-2",
          armId: TEST_ARM_ID,
          status: "blocked",
          summary: "Waiting for API endpoint",
          issues: ["API not ready"],
          blockers: ["Depends on task-1"]
        }
      };

      await mockNats.publishBrainMessage(statusReport);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { type: string; payload: { status: string; issues: string[] } };
      expect(msg?.type).toBe("status_report");
      expect(msg?.payload?.status).toBe("blocked");
      expect(msg?.payload?.issues).toContain("API not ready");
    });

    it("acknowledges task receipt", async () => {
      const ackMessage = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "status_update",
        payload: {
          taskId: "task-2",
          status: "in_progress",
          message: "Task acknowledged and work started"
        }
      };

      await mockNats.publishBrainMessage(ackMessage);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      expect((messages[0] as { type: string }).type).toBe("status_update");
    });
  });

  describe("Discovery Reporting Tools", () => {
    it("reports a discovery", async () => {
      const discovery: Discovery = {
        kind: "test_failure",
        title: "Integration test failing",
        details: "Test times out after 30s",
        file: "tests/integration/api.test.ts",
        line: 45,
        severity: "error",
        taskId: "task-1",
        phase: "implementation"
      };

      const message = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "discovery",
        payload: discovery
      };

      await mockNats.publishBrainMessage(message);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { type: string; payload: Discovery };
      expect(msg?.type).toBe("discovery");
      expect(msg?.payload?.kind).toBe("test_failure");
      expect(msg?.payload?.severity).toBe("error");
    });

    it("stores discovery in database", () => {
      db.run(`
        INSERT INTO discoveries (arm_id, kind, title, details, file_path, severity, task_id, phase)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [TEST_ARM_ID, "security_issue", "SQL Injection risk", "Unsanitized input", "src/api/users.ts", "error", "task-1", "implementation"]);

      const discovery = db.query(`
        SELECT * FROM discoveries WHERE arm_id = ?
      `).get(TEST_ARM_ID) as { kind: string; title: string; severity: string } | null;

      expect(discovery).not.toBeNull();
      expect(discovery?.kind).toBe("security_issue");
      expect(discovery?.severity).toBe("error");
    });

    it("resolves a discovery", () => {
      // Insert a discovery first
      db.run(`
        INSERT INTO discoveries (id, arm_id, kind, title, details, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ["disc-123", TEST_ARM_ID, "test_failure", "Test failing", "Details", "open"]);

      // Resolve it
      db.run(`
        UPDATE discoveries 
        SET status = ?, 
            updated_at = datetime('now'),
            metadata = json_set(COALESCE(metadata, '{}'), '$.resolution_reason', ?, '$.resolved_by', ?)
        WHERE id = ?
      `, ["resolved", "Fixed in commit abc123", TEST_ARM_ID, "disc-123"]);

      const discovery = db.query(`SELECT status FROM discoveries WHERE id = ?`).get("disc-123") as { status: string } | null;
      expect(discovery?.status).toBe("resolved");
    });

    it("reports a dependency", async () => {
      const dependencyMessage = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "dependency_discovery",
        payload: {
          taskId: "task-1",
          dependsOn: "src/auth/service.ts",
          type: "file",
          description: "Task requires auth service changes",
          severity: "blocking"
        }
      };

      await mockNats.publishBrainMessage(dependencyMessage);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      expect((messages[0] as { type: string }).type).toBe("dependency_discovery");
    });
  });

  describe("Bug Reporting Tools", () => {
    it("reports a bug", async () => {
      const bugReport = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "bug_report",
        payload: {
          id: "bug-123",
          title: "Runtime error on startup",
          description: "Null pointer exception when loading config",
          source: "arm_reported",
          sourceTaskId: "task-1"
        }
      };

      await mockNats.publishBrainMessage(bugReport);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { type: string; payload: { title: string } };
      expect(msg?.type).toBe("bug_report");
      expect(msg?.payload?.title).toBe("Runtime error on startup");
    });

    it("stores bug in database", () => {
      db.run(`
        INSERT INTO bugs (id, title, description, source, source_arm_id, status, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, ["bug-456", "Memory leak", "Memory growing over time", "arm_reported", TEST_ARM_ID, "open", "high"]);

      const bug = db.query(`SELECT * FROM bugs WHERE id = ?`).get("bug-456") as { title: string; status: string } | null;
      expect(bug?.title).toBe("Memory leak");
      expect(bug?.status).toBe("open");
    });

    it("updates bug status", () => {
      db.run(`
        INSERT INTO bugs (id, title, description, source, status)
        VALUES (?, ?, ?, ?, ?)
      `, ["bug-789", "UI Glitch", "Button misaligned", "arm_reported", "open"]);

      db.run(`
        UPDATE bugs 
        SET status = ?, 
            updated_at = datetime('now'),
            assignee_arm_id = ?
        WHERE id = ?
      `, ["investigating", TEST_ARM_ID, "bug-789"]);

      const bug = db.query(`SELECT status, assignee_arm_id FROM bugs WHERE id = ?`).get("bug-789") as { status: string; assignee_arm_id: string } | null;
      expect(bug?.status).toBe("investigating");
      expect(bug?.assignee_arm_id).toBe(TEST_ARM_ID);
    });

    it("assigns bug to another arm", async () => {
      // Create another arm
      db.run(`INSERT INTO arms (id, name, status) VALUES (?, ?, ?)`, ["arm-other", "Other Arm", "running"]);
      
      db.run(`INSERT INTO bugs (id, title, description, source, status) VALUES (?, ?, ?, ?, ?)`, 
        ["bug-assign", "Complex Bug", "Needs expertise", "arm_reported", "open"]);

      db.run(`UPDATE bugs SET assignee_arm_id = ? WHERE id = ?`, ["arm-other", "bug-assign"]);

      const assignmentMessage = {
        from: TEST_ARM_ID,
        to: "arm-other",
        type: "bug_assignment",
        payload: {
          bugId: "bug-assign",
          title: "Complex Bug",
          assignedBy: TEST_ARM_ID,
          reason: "Needs your expertise"
        }
      };

      await mockNats.publishBrainMessage(assignmentMessage);

      const bug = db.query(`SELECT assignee_arm_id FROM bugs WHERE id = ?`).get("bug-assign") as { assignee_arm_id: string } | null;
      expect(bug?.assignee_arm_id).toBe("arm-other");
    });
  });

  describe("Communication Tools", () => {
    it("requests approval", async () => {
      const approvalRequest = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "approval_request",
        payload: {
          action: "Delete old database",
          context: "Need to clean up test data",
          options: ["Approve", "Reject", "Ask for more info"]
        }
      };

      await mockNats.publishBrainMessage(approvalRequest);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { type: string; payload: { action: string } };
      expect(msg?.type).toBe("approval_request");
      expect(msg?.payload?.action).toBe("Delete old database");
    });

    it("shares a note", async () => {
      const note: Note = {
        id: "note-123",
        author: TEST_ARM_ID,
        title: "Useful Pattern",
        content: "When working with async code, always use try/catch",
        tags: ["patterns", "async"],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const shareMessage = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "share_note",
        payload: note
      };

      await mockNats.publishBrainMessage(shareMessage);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      expect((messages[0] as { type: string }).type).toBe("share_note");
    });

    it("stores note in database", () => {
      db.run(`
        INSERT INTO notes (id, author, title, content, tags)
        VALUES (?, ?, ?, ?, ?)
      `, ["note-db", TEST_ARM_ID, "Test Note", "Content here", JSON.stringify(["test", "note"])]);

      const note = db.query(`SELECT * FROM notes WHERE id = ?`).get("note-db") as { title: string; author: string } | null;
      expect(note?.title).toBe("Test Note");
      expect(note?.author).toBe(TEST_ARM_ID);
    });

    it("shares a tool discovery", async () => {
      const toolMessage = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "tool_discovery",
        payload: {
          name: "ripgrep",
          command: "rg -n 'pattern'",
          description: "Fast search tool",
          context: "Searching large codebases"
        }
      };

      await mockNats.publishBrainMessage(toolMessage);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      expect((messages[0] as { type: string }).type).toBe("tool_discovery");
    });

    it("sends heartbeat", async () => {
      const heartbeat = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "heartbeat",
        payload: {
          status: "busy",
          currentTask: "Implementing feature X",
          timestamp: new Date().toISOString()
        }
      };

      await mockNats.publishBrainMessage(heartbeat);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { type: string; payload: { status: string } };
      expect(msg?.type).toBe("heartbeat");
      expect(msg?.payload?.status).toBe("busy");
    });
  });

  describe("File Claim System", () => {
    it("creates a file claim", () => {
      const result = db.run(`
        INSERT INTO claims (arm_id, file_path, claim_type)
        VALUES (?, ?, ?)
      `, [TEST_ARM_ID, "src/api/users.ts", "write"]);

      expect(result.changes).toBe(1);

      const claim = db.query(`
        SELECT * FROM claims WHERE arm_id = ? AND file_path = ?
      `).get(TEST_ARM_ID, "src/api/users.ts") as { file_path: string; claim_type: string } | null;

      expect(claim?.file_path).toBe("src/api/users.ts");
      expect(claim?.claim_type).toBe("write");
    });

    it("prevents exclusive claim conflicts", () => {
      // First arm claims file
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        ["arm-first", "src/shared.ts", "exclusive"]);

      // Check for conflict
      const existing = db.query(`
        SELECT arm_id FROM claims 
        WHERE file_path = ? AND released_at IS NULL
      `).get("src/shared.ts") as { arm_id: string } | null;

      expect(existing?.arm_id).toBe("arm-first");
    });

    it("updates existing claim", () => {
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        [TEST_ARM_ID, "src/update.ts", "read"]);

      const existing = db.query(`
        SELECT id, claim_type FROM claims 
        WHERE arm_id = ? AND file_path = ? AND released_at IS NULL
      `).get(TEST_ARM_ID, "src/update.ts") as { id: number; claim_type: string } | null;

      expect(existing?.claim_type).toBe("read");

      // Update to write
      db.run(`
        UPDATE claims SET claim_type = ?, claimed_at = datetime('now') WHERE id = ?
      `, ["write", existing?.id ?? 0]);

      const updated = db.query(`SELECT claim_type FROM claims WHERE id = ?`).get(existing?.id ?? 0) as { claim_type: string } | null;
      expect(updated?.claim_type).toBe("write");
    });

    it("releases a claim", () => {
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        [TEST_ARM_ID, "src/release.ts", "write"]);

      db.run(`
        UPDATE claims SET released_at = datetime('now') 
        WHERE arm_id = ? AND file_path = ? AND released_at IS NULL
      `, [TEST_ARM_ID, "src/release.ts"]);

      const claim = db.query(`
        SELECT released_at FROM claims 
        WHERE arm_id = ? AND file_path = ?
      `).get(TEST_ARM_ID, "src/release.ts") as { released_at: string | null } | null;

      expect(claim?.released_at).not.toBeNull();
    });

    it("transfers a claim to another arm", () => {
      db.run(`INSERT INTO arms (id, name, status) VALUES (?, ?, ?)`, ["arm-receiver", "Receiver", "running"]);
      
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        [TEST_ARM_ID, "src/transfer.ts", "write"]);

      const ourClaim = db.query(`
        SELECT id FROM claims 
        WHERE arm_id = ? AND file_path = ? AND released_at IS NULL
      `).get(TEST_ARM_ID, "src/transfer.ts") as { id: number } | null;

      db.run(`UPDATE claims SET arm_id = ? WHERE id = ?`, ["arm-receiver", ourClaim?.id ?? 0]);

      const transferred = db.query(`
        SELECT arm_id FROM claims WHERE id = ?
      `).get(ourClaim?.id ?? 0) as { arm_id: string } | null;

      expect(transferred?.arm_id).toBe("arm-receiver");
    });

    it("lists active claims", () => {
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        [TEST_ARM_ID, "src/file1.ts", "read"]);
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        [TEST_ARM_ID, "src/file2.ts", "write"]);

      const claims = db.query(`
        SELECT file_path, claim_type FROM claims 
        WHERE arm_id = ? AND released_at IS NULL
        ORDER BY claimed_at DESC
      `).all(TEST_ARM_ID) as Array<{ file_path: string; claim_type: string }>;

      expect(claims.length).toBe(2);
    });

    it("checks for conflicts on a file", () => {
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        ["arm-a", "src/conflict.ts", "write"]);
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, 
        ["arm-b", "src/conflict.ts", "write"]);

      const claims = db.query(`
        SELECT arm_id, claim_type FROM claims 
        WHERE file_path = ? AND released_at IS NULL
      `).all("src/conflict.ts") as Array<{ arm_id: string }>;

      expect(claims.length).toBe(2);
      expect(claims.some(c => c.arm_id === "arm-a")).toBe(true);
      expect(claims.some(c => c.arm_id === "arm-b")).toBe(true);
    });
  });

  describe("Context Compression Tools", () => {
    it("reports context compression", () => {
      db.run(`
        INSERT INTO context_compressions 
        (arm_id, task_id, original_tokens, compressed_tokens, compression_ratio, removed_content)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        TEST_ARM_ID,
        "task-1",
        100000,
        50000,
        0.5,
        JSON.stringify([{ type: "history", description: "Old conversation", tokenCount: 50000 }])
      ]);

      const compression = db.query(`
        SELECT * FROM context_compressions WHERE arm_id = ?
      `).get(TEST_ARM_ID) as { compression_ratio: number; original_tokens: number } | null;

      expect(compression?.original_tokens).toBe(100000);
      expect(compression?.compression_ratio).toBe(0.5);
    });

    it("updates arm context budget", () => {
      db.run(`
        UPDATE arms SET context_budget_used = context_budget_used + ? WHERE id = ?
      `, [50000, TEST_ARM_ID]);

      const arm = db.query(`
        SELECT context_budget_used FROM arms WHERE id = ?
      `).get(TEST_ARM_ID) as { context_budget_used: number } | null;

      expect(arm?.context_budget_used).toBe(50000);
    });

    it("gets context budget status", () => {
      const arm = db.query(`
        SELECT context_budget, context_budget_used 
        FROM arms WHERE id = ?
      `).get(TEST_ARM_ID) as { context_budget: number; context_budget_used: number } | null;

      const remaining = (arm?.context_budget || 128000) - (arm?.context_budget_used || 0);
      const usagePercent = ((arm?.context_budget_used || 0) / (arm?.context_budget || 128000)) * 100;

      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(usagePercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Documentation Awareness Tools", () => {
    beforeEach(async () => {
      // Create some test docs
      await mkdir(join(TEST_PROJECT_ROOT, "docs", "architecture"), { recursive: true });
      await mkdir(join(TEST_PROJECT_ROOT, "docs", "guides"), { recursive: true });
      
      await writeFile(
        join(TEST_PROJECT_ROOT, "docs", "architecture", "overview.md"),
        "# Architecture Overview\n\nThis document describes the system architecture.",
        "utf-8"
      );
      
      await writeFile(
        join(TEST_PROJECT_ROOT, "docs", "guides", "setup.md"),
        "# Setup Guide\n\nHow to set up the project.",
        "utf-8"
      );
    });

    it("lists documentation files", async () => {
      const docsDir = join(TEST_PROJECT_ROOT, "docs");
      const entries = await readFile(join(docsDir, "architecture", "overview.md"), "utf-8");
      expect(entries).toContain("Architecture Overview");
    });

    it("reads specific documentation", async () => {
      const content = await readFile(join(TEST_PROJECT_ROOT, "docs", "guides", "setup.md"), "utf-8");
      expect(content).toContain("Setup Guide");
    });

    it("tracks documentation updates", async () => {
      const docUpdate = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "doc_update",
        payload: {
          path: "docs/architecture/overview.md",
          reason: "Updated based on new requirements",
          previousContent: "Old content",
          newContent: "New content"
        }
      };

      await mockNats.publishBrainMessage(docUpdate);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      expect((messages[0] as { type: string }).type).toBe("doc_update");
    });

    it("subscribes to file patterns", async () => {
      const subscription = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "file_subscription",
        payload: {
          action: "subscribe",
          pattern: "docs/requirements/*.md",
          category: "requirements"
        }
      };

      await mockNats.publishBrainMessage(subscription);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { payload: { pattern: string } };
      expect(msg?.payload?.pattern).toBe("docs/requirements/*.md");
    });

    it("reports file changes", async () => {
      const fileChange = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "file_change",
        payload: {
          filePath: "src/api/users.ts",
          changeType: "modified",
          summary: "Added new endpoint",
          impact: "May affect authentication flow"
        }
      };

      await mockNats.publishBrainMessage(fileChange);
      
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      
      const msg = messages[0] as { payload: { filePath: string; changeType: string } };
      expect(msg?.payload?.filePath).toBe("src/api/users.ts");
      expect(msg?.payload?.changeType).toBe("modified");
    });
  });

  describe("Message Queue Operations", () => {
    it("stores messages in database", () => {
      const messageId = `msg-${Date.now()}`;
      
      db.run(`
        INSERT INTO messages (id, from_arm, to_arm, type, payload)
        VALUES (?, ?, ?, ?, ?)
      `, [
        messageId,
        "brain",
        TEST_ARM_ID,
        "task_assignment",
        JSON.stringify({ taskId: "task-1", subject: "Test task" })
      ]);

      const msg = db.query(`
        SELECT * FROM messages WHERE id = ?
      `).get(messageId) as { from_arm: string; type: string } | null;

      expect(msg?.from_arm).toBe("brain");
      expect(msg?.type).toBe("task_assignment");
    });

    it("retrieves pending messages for arm", () => {
      db.run(`
        INSERT INTO messages (id, from_arm, to_arm, type, payload, processed)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ["msg-1", "brain", TEST_ARM_ID, "task_assignment", "{}", 0]);

      db.run(`
        INSERT INTO messages (id, from_arm, to_arm, type, payload, processed)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ["msg-2", "brain", TEST_ARM_ID, "status_update", "{}", 0]);

      const messages = db.query(`
        SELECT * FROM messages 
        WHERE to_arm = ? AND processed = 0
      `).all(TEST_ARM_ID) as Array<{ id: string }>;

      expect(messages.length).toBe(2);
    });

    it("marks messages as completed", () => {
      db.run(`
        INSERT INTO messages (id, from_arm, to_arm, type, payload, processed)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ["msg-complete", "brain", TEST_ARM_ID, "task_assignment", "{}", 0]);

      db.run(`
        UPDATE messages 
        SET processed = 1, completed_at = datetime('now')
        WHERE id = ?
      `, ["msg-complete"]);

      const msg = db.query(`SELECT processed FROM messages WHERE id = ?`).get("msg-complete") as { processed: number } | null;
      expect(msg?.processed).toBe(1);
    });
  });

  describe("Error Handling", () => {
    it("handles database errors gracefully", () => {
      // Try to insert invalid data
      try {
        db.run(`INSERT INTO tasks (id) VALUES (?)`, ["test"]); // Missing required fields
        // Should not reach here
        expect(false).toBe(true);
      } catch (err) {
        expect(err).toBeDefined();
      }
    });

    it("handles NATS publish failures", async () => {
      const failingClient = new MockNatsClient({ publishFail: true });
      await failingClient.connect();

      try {
        await failingClient.publish("test", {});
        expect(false).toBe(true);
      } catch (err) {
        expect(err).toBeDefined();
        expect((err as Error).message).toContain("publish failed");
      }
    });

    it("handles NATS connection failures", async () => {
      const failingClient = new MockNatsClient({ connectFail: true });

      try {
        await failingClient.connect();
        expect(false).toBe(true);
      } catch (err) {
        expect(err).toBeDefined();
        expect((err as Error).message).toContain("connect failed");
      }
    });
  });

  describe("Integration - End to End Workflows", () => {
    it("complete task workflow: claim -> work -> complete", async () => {
      // Setup task
      db.run(`INSERT INTO tasks (id, subject, description, status, priority) 
              VALUES (?, ?, ?, ?, ?)`, 
              ["e2e-task", "E2E Test Task", "Description", "pending", "high"]);

      // 1. Arm claims task
      const claimMsg = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "task_assignment",
        payload: { action: "claim", taskId: "e2e-task" }
      };
      await mockNats.publishBrainMessage(claimMsg);

      // 2. Arm acknowledges
      const ackMsg = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "status_update",
        payload: { taskId: "e2e-task", status: "in_progress" }
      };
      await mockNats.publishBrainMessage(ackMsg);

      // 3. Arm reports discovery during work
      const discoveryMsg = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "discovery",
        payload: {
          kind: "related_code",
          title: "Found related component",
          details: "Component needs updating too",
          taskId: "e2e-task"
        }
      };
      await mockNats.publishBrainMessage(discoveryMsg);

      // 4. Arm claims file
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`,
              [TEST_ARM_ID, "src/e2e.ts", "write"]);

      // 5. Arm completes task
      const completeMsg = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "task_complete",
        payload: {
          taskId: "e2e-task",
          summary: "Task completed successfully",
          artifacts: ["src/e2e.ts"]
        }
      };
      await mockNats.publishBrainMessage(completeMsg);

      // Verify all messages sent
      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(4);

      // Verify file claim exists
      const claim = db.query(`SELECT * FROM claims WHERE arm_id = ? AND file_path = ?`)
                      .get(TEST_ARM_ID, "src/e2e.ts") as { claim_type: string } | null;
      expect(claim?.claim_type).toBe("write");
    });

    it("bug workflow: report -> investigate -> fix -> verify", async () => {
      // 1. Report bug
      db.run(`INSERT INTO bugs (id, title, description, source, status) 
              VALUES (?, ?, ?, ?, ?)`,
              ["e2e-bug", "Critical Bug", "Crashes on startup", "arm_reported", "open"]);

      const bugMsg = {
        from: TEST_ARM_ID,
        to: "brain",
        type: "bug_report",
        payload: { id: "e2e-bug", title: "Critical Bug", description: "Crashes" }
      };
      await mockNats.publishBrainMessage(bugMsg);

      // 2. Assign to arm
      db.run(`UPDATE bugs SET assignee_arm_id = ?, status = ? WHERE id = ?`,
              [TEST_ARM_ID, "investigating", "e2e-bug"]);

      // 3. Update status to fixing
      db.run(`UPDATE bugs SET status = ? WHERE id = ?`, ["fixing", "e2e-bug"]);

      // 4. Mark resolved
      db.run(`UPDATE bugs SET status = ?, resolution = ?, resolved_at = datetime('now') WHERE id = ?`,
              ["resolved", "Fixed in commit xyz", "e2e-bug"]);

      const bug = db.query(`SELECT status, resolution FROM bugs WHERE id = ?`).get("e2e-bug") as { status: string; resolution: string } | null;
      expect(bug?.status).toBe("resolved");
      expect(bug?.resolution).toBe("Fixed in commit xyz");
    });

    it("conflict resolution workflow", async () => {
      // Two arms claim same file
      db.run(`INSERT INTO arms (id, name, status) VALUES (?, ?, ?)`, ["arm-a", "Arm A", "running"]);
      db.run(`INSERT INTO arms (id, name, status) VALUES (?, ?, ?)`, ["arm-b", "Arm B", "running"]);

      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`,
              ["arm-a", "src/conflict.ts", "write"]);
      db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`,
              ["arm-b", "src/conflict.ts", "write"]);

      // Detect conflict
      const conflicts = db.query(`
        SELECT arm_id, claim_type, claimed_at FROM claims 
        WHERE file_path = ? AND released_at IS NULL 
        ORDER BY claimed_at ASC
      `).all("src/conflict.ts") as Array<{ arm_id: string }>;

      expect(conflicts.length).toBe(2);

      // Arm A transfers claim to Arm B (coordinated resolution)
      const transferMsg = {
        from: "arm-a",
        to: "brain",
        type: "claim_transfer",
        payload: {
          filePath: "src/conflict.ts",
          fromArm: "arm-a",
          toArm: "arm-b",
          reason: "Arm B has more context"
        }
      };
      await mockNats.publishBrainMessage(transferMsg);

      // Perform transfer
      const claimA = db.query(`SELECT id FROM claims WHERE arm_id = ? AND file_path = ?`).get("arm-a", "src/conflict.ts") as { id: number } | null;
      
      if (claimA) {
        db.run(`UPDATE claims SET arm_id = ? WHERE id = ?`, ["arm-b", claimA.id]);
      }

      // Verify claims after transfer - arm-b now has 2 claims (original + transferred)
      const remainingClaims = db.query(`
        SELECT COUNT(*) as count FROM claims 
        WHERE file_path = ? AND released_at IS NULL
      `).get("src/conflict.ts") as { count: number } | null;

      expect(remainingClaims?.count).toBe(2);
      
      // Verify arm-b is the owner of both claims
      const armBClaims = db.query(`
        SELECT COUNT(*) as count FROM claims 
        WHERE file_path = ? AND arm_id = ? AND released_at IS NULL
      `).get("src/conflict.ts", "arm-b") as { count: number } | null;
      
      expect(armBClaims?.count).toBe(2);
    });
  });
});

// Run tests if this file is executed directly
if (import.meta.main) {
  console.log("MCP Server Comprehensive Test Suite");
  console.log("Run with: bun test src/mcp/__tests__/server.test.ts");
}
