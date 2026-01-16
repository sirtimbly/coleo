/**
 * MCP Server Tests
 * 
 * Tests for the MCP server tools that arms use to communicate with the Brain.
 * Uses mocked NATS client and SQLite database.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MockNatsClient, createMockNatsClient } from "../../nats/__mocks__/client";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile, readFile, readdir } from "fs/promises";
import { join } from "path";
import type { Discovery, QueueMessage } from "../../types";

describe("MCP Server - sendToBrain (with mocked NATS)", () => {
  let mockNats: MockNatsClient;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `octopai-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    
    mockNats = createMockNatsClient();
    await mockNats.connect();
  });

  afterEach(async () => {
    await mockNats.disconnect();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe("NATS publishing", () => {
    it("publishes brain messages via NATS when connected", async () => {
      await mockNats.publishBrainMessage({
        from: "arm-test",
        to: "brain" as const,
        type: "discovery" as const,
        payload: {
          kind: "test_failure" as const,
          title: "Test failed",
          details: "Unit test failed",
          severity: "error" as const,
        },
        timestamp: new Date().toISOString(),
      });

      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(1);
      expect(messages[0]?.from).toBe("arm-test");
      expect(messages[0]?.type).toBe("discovery");
    });

    it("tracks multiple published messages", async () => {
      for (let i = 0; i < 3; i++) {
        await mockNats.publishBrainMessage({
          from: `arm-${i}`,
          to: "brain",
          type: "heartbeat",
          payload: { status: "idle" },
          timestamp: new Date().toISOString(),
        });
      }

      const messages = mockNats.getBrainMessages();
      expect(messages.length).toBe(3);
    });

    it("filters messages by topic", async () => {
      await mockNats.publish("octopai.brain.messages", { type: "discovery" });
      await mockNats.publish("octopai.brain.messages", { type: "heartbeat" });
      await mockNats.publish("other.topic", { type: "other" });

      const brainMessages = mockNats.getPublishedMessagesByType<{ type: string }>("octopai.brain.messages");
      expect(brainMessages.length).toBe(2);
    });
  });

  describe("Subscription handling", () => {
    it("triggers handlers for matching subscriptions", async () => {
      const received: unknown[] = [];
      
      mockNats.subscribe("octopai.brain.messages", (data) => {
        received.push(data);
      });

      await mockNats.triggerMessage("octopai.brain.messages", { test: true });
      expect(received.length).toBe(1);
      expect(received[0]).toEqual({ test: true });
    });

    it("supports multiple subscriptions to same topic", async () => {
      let callCount = 0;
      
      mockNats.subscribe("test", () => { callCount++; });
      mockNats.subscribe("test", () => { callCount++; });

      await mockNats.triggerMessage("test", {});

      expect(callCount).toBe(2);
    });

    it("allows unsubscribing", async () => {
      const received: unknown[] = [];
      
      const sub = mockNats.subscribe("test", (data) => { received.push(data); });
      sub.unsubscribe();

      await mockNats.triggerMessage("test", { test: true });
      expect(received.length).toBe(0);
    });
  });

  describe("Connection state", () => {
    it("tracks connected state", async () => {
      expect(mockNats.isConnected()).toBe(true);
    });

    it("disconnects properly", async () => {
      await mockNats.disconnect();
      expect(mockNats.isConnected()).toBe(false);
    });

    it("fails to publish when not connected", async () => {
      await mockNats.disconnect();
      
      await expect(mockNats.publish("topic", {})).rejects.toThrow("Not connected to NATS");
    });
  });

  describe("Error handling", () => {
    it("handles publish failures gracefully", async () => {
      const failClient = createMockNatsClient({ publishFail: true });
      await failClient.connect();

      await expect(failClient.publish("topic", {})).rejects.toThrow("Mock publish failed");
    });

    it("handles connect failures", async () => {
      const failClient = createMockNatsClient({ connectFail: true });
      
      await expect(failClient.connect()).rejects.toThrow("Mock connect failed");
      expect(failClient.isConnected()).toBe(false);
    });
  });
});

describe("MCP Server - File Queue Fallback", () => {
  let testDir: string;
  let octopaiDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `octopai-queue-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    octopaiDir = join(testDir, ".octopai");
    
    await mkdir(join(octopaiDir, "queue", "brain", "pending"), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("writes messages to file queue", async () => {
    const message: QueueMessage = {
      id: "test-msg-1",
      from: "arm-test",
      to: "brain",
      type: "discovery",
      payload: {
        kind: "test_failure",
        title: "Test discovery",
        details: "Details here",
      },
      timestamp: new Date(),
    };

    const filename = `${message.id}-${message.from}-${message.type}.json`;
    const filepath = join(octopaiDir, "queue", "brain", "pending", filename);
    
    await writeFile(filepath, JSON.stringify(message, null, 2), "utf-8");

    const content = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(content);
    
    expect(parsed.id).toBe("test-msg-1");
    expect(parsed.from).toBe("arm-test");
    expect(parsed.type).toBe("discovery");
  });

  it("creates queue directory if missing", async () => {
    const newDir = join(testDir, "new-queue", "brain", "pending");
    
    await mkdir(newDir, { recursive: true });
    
    const message: QueueMessage = {
      id: "test-msg-2",
      from: "arm-test",
      to: "brain",
      type: "heartbeat",
      payload: { status: "idle" },
      timestamp: new Date(),
    };

    await writeFile(
      join(newDir, `${message.id}.json`),
      JSON.stringify(message),
      "utf-8"
    );

    const files = await readdir(newDir);
    expect(files.length).toBe(1);
  });
});

describe("MCP Server - Task Tools Integration", () => {
  let db: Database;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `octopai-task-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const dbPath = join(testDir, "test.db");
    
    await mkdir(testDir, { recursive: true });
    db = new Database(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      
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

      INSERT INTO tasks (id, subject, description, status, priority, domain)
      VALUES 
        ('task-1', 'Implement feature X', 'Do the work', 'pending', 'high', 'backend'),
        ('task-2', 'Fix bug Y', 'Debug the issue', 'in_progress', 'critical', 'frontend'),
        ('task-3', 'Write tests', 'Add unit tests', 'pending', 'normal', 'testing');
    `);
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("queries pending tasks from database", () => {
    const tasks = db.query(`
      SELECT id, subject, status, priority, domain
      FROM tasks
      WHERE status IN ('pending', 'claimed')
      AND (assigned_to IS NULL)
      ORDER BY 
        CASE priority 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'normal' THEN 3 
          WHEN 'low' THEN 4 
        END,
        created_at ASC
    `).all() as Array<{ id: string; subject: string; status: string; priority: string; domain: string | null }>;

    expect(tasks.length).toBe(2); // task-1 and task-3
    expect(tasks[0]?.id).toBe("task-1"); // high priority
    expect(tasks[1]?.id).toBe("task-3"); // normal priority
  });

  it("filters tasks by assigned arm", () => {
    db.run(`UPDATE tasks SET assigned_to = 'arm-1' WHERE id = 'task-3'`);

    const tasksForArm = db.query(`
      SELECT id, assigned_to
      FROM tasks
      WHERE status IN ('pending', 'claimed', 'in_progress')
      AND (assigned_to = ? OR assigned_to IS NULL)
    `).all("arm-1") as Array<{ id: string; assigned_to: string | null }>;

    // task-1: unassigned + pending = returned
    // task-2: unassigned + in_progress = returned
    // task-3: assigned_to = 'arm-1' + pending = returned
    expect(tasksForArm.length).toBe(3);
    
    // Exactly one task is assigned to arm-1
    const assignedToArm = tasksForArm.filter(t => t.assigned_to === "arm-1");
    expect(assignedToArm.length).toBe(1);
    expect(assignedToArm[0]?.id).toBe("task-3");
  });

  it("updates task status", () => {
    db.run(`
      UPDATE tasks 
      SET status = 'completed', 
          updated_at = datetime('now')
      WHERE id = 'task-2'
    `);

    const task = db.query(`SELECT status FROM tasks WHERE id = 'task-2'`).get() as { status: string };
    expect(task?.status).toBe("completed");
  });
});

describe("MCP Server - Discovery Reporting", () => {
  let mockNats: MockNatsClient;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `octopai-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mockNats = createMockNatsClient();
    await mockNats.connect();
  });

  afterEach(async () => {
    await mockNats.disconnect();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("publishes discovery as brain message", async () => {
    const discovery: Discovery = {
      kind: "test_failure",
      title: "Tests failing in CI",
      details: "Integration tests are failing due to timeout issues",
      file: "src/api/test.ts",
      line: 42,
      severity: "error",
    };

    await mockNats.publishBrainMessage({
      from: "arm-test",
      to: "brain",
      type: "discovery",
      payload: discovery,
      timestamp: new Date().toISOString(),
    });

    const messages = mockNats.getBrainMessages();
    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("discovery");
    
    const payload = messages[0]?.payload as Discovery;
    expect(payload?.kind).toBe("test_failure");
    expect(payload?.title).toBe("Tests failing in CI");
    expect(payload?.severity).toBe("error");
  });

  it("publishes heartbeat as brain message", async () => {
    await mockNats.publishBrainMessage({
      from: "arm-heartbeat",
      to: "brain",
      type: "heartbeat",
      payload: {
        status: "busy",
        currentTask: "Implementing feature X",
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

    const messages = mockNats.getBrainMessages();
    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("heartbeat");
  });

  it("publishes task completion as brain message", async () => {
    await mockNats.publishBrainMessage({
      from: "arm-complete",
      to: "brain",
      type: "task_complete",
      payload: {
        taskId: "task-123",
        summary: "Completed feature implementation",
        artifacts: ["src/feature.ts", "tests/feature.test.ts"],
      },
      timestamp: new Date().toISOString(),
    });

    const messages = mockNats.getBrainMessages();
    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("task_complete");
    
    const payload = messages[0]?.payload as { taskId: string; summary: string; artifacts: string[] };
    expect(payload?.taskId).toBe("task-123");
    expect(payload?.artifacts?.length).toBe(2);
  });

  it("publishes task claim as brain message", async () => {
    await mockNats.publishBrainMessage({
      from: "arm-claim",
      to: "brain",
      type: "task_assignment",
      payload: {
        action: "claim",
        taskId: "task-456",
      },
      timestamp: new Date().toISOString(),
    });

    const messages = mockNats.getBrainMessages();
    expect(messages.length).toBe(1);
    expect(messages[0]?.type).toBe("task_assignment");
    
    const payload = messages[0]?.payload as { action: string; taskId: string };
    expect(payload?.action).toBe("claim");
    expect(payload?.taskId).toBe("task-456");
  });
});

describe("MCP Server - Note Sharing", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `octopai-notes-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(join(testDir, "notes", "shared"), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("writes note to shared directory", async () => {
    const note = {
      id: "note-1",
      author: "arm-1",
      title: "Important discovery",
      content: "Found a better approach...",
      tags: ["architecture", "performance"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const filepath = join(testDir, "notes", "shared", `${note.id}.json`);
    await writeFile(filepath, JSON.stringify(note, null, 2), "utf-8");

    const content = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(content);
    
    expect(parsed.id).toBe("note-1");
    expect(parsed.author).toBe("arm-1");
    expect(parsed.tags).toEqual(["architecture", "performance"]);
  });

  it("reads notes from shared directory", async () => {
    for (let i = 1; i <= 3; i++) {
      const note = {
        id: `note-${i}`,
        author: `arm-${i}`,
        title: `Note ${i}`,
        content: `Content for note ${i}`,
        tags: i % 2 === 0 ? ["tag-a"] : ["tag-b"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeFile(
        join(testDir, "notes", "shared", `${note.id}.json`),
        JSON.stringify(note),
        "utf-8"
      );
    }

    const files = await readdir(join(testDir, "notes", "shared"));
    const notes: unknown[] = [];
    for (const f of files) {
      if (f.endsWith(".json")) {
        const content = await readFile(join(testDir, "notes", "shared", f), "utf-8");
        notes.push(JSON.parse(content));
      }
    }

    expect(notes.length).toBe(3);
  });
});

describe("MCP Server - File Claims", () => {
  let db: Database;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `octopai-claims-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const dbPath = join(testDir, "test.db");
    
    await mkdir(testDir, { recursive: true });
    db = new Database(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arm_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        claim_type TEXT NOT NULL DEFAULT 'read',
        claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
        released_at TEXT
      );
    `);
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("creates a file claim", () => {
    db.run(`
      INSERT INTO claims (arm_id, file_path, claim_type)
      VALUES (?, ?, ?)
    `, ["arm-1", "src/feature.ts", "write"]);

    const claim = db.query(`SELECT * FROM claims WHERE arm_id = ?`).get("arm-1") as Record<string, unknown>;
    expect(claim).not.toBeNull();
    expect(claim?.file_path).toBe("src/feature.ts");
    expect(claim?.claim_type).toBe("write");
  });

  it("releases a file claim", () => {
    db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, ["arm-1", "src/old.ts", "read"]);

    db.run(`UPDATE claims SET released_at = datetime('now') WHERE arm_id = ? AND file_path = ?`, ["arm-1", "src/old.ts"]);

    const claim = db.query(`SELECT released_at FROM claims WHERE arm_id = ?`).get("arm-1") as { released_at: string | null };
    expect(claim?.released_at).not.toBeNull();
  });

  it("finds conflicting claims", () => {
    db.run(`INSERT INTO claims (arm_id, file_path, claim_type) VALUES (?, ?, ?)`, ["arm-1", "src/shared.ts", "write"]);
    
    const exclusiveClaim = db.query(`
      SELECT * FROM claims 
      WHERE file_path = ? 
      AND released_at IS NULL
      AND claim_type = 'exclusive'
    `).get("src/shared.ts");

    expect(exclusiveClaim).toBeNull();
  });
});
