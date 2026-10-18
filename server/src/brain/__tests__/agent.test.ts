/**
 * Brain Agent Tests
 * 
 * Tests for the agentic brain implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BrainAgent } from "../agent";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { createSqliteBrainDb } from "../../db/brain-db-adapter";

describe("BrainAgent", () => {
  let db: Database;
  let agent: BrainAgent;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const coleoDir = join(testDir, ".coleo");
    
    await mkdir(join(coleoDir, "db"), { recursive: true });
    
    db = new Database(join(coleoDir, "test.db"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        domain TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        severity TEXT DEFAULT 'info',
        file_path TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS arms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        current_task_subject TEXT,
        last_activity_at TEXT
      );
    `);

    const context = {
      db: createSqliteBrainDb(db),
      projectRoot: testDir,
      coleoDir,
    };

    agent = new BrainAgent(context);
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe("invoke", () => {
    it("returns no action for empty messages", async () => {
      const result = await agent.invoke({ messages: [] });
      
      expect(result.actions).toEqual([]);
      expect(result.response).toBe("No action taken");
    });

    it("returns help response for unrecognized query", async () => {
      const result = await agent.invoke({
        messages: [{
          role: "user",
          content: "What is the meaning of life?",
        }],
      });
      
      expect(result.response).toContain("I'm not sure what specific action you need");
      expect(result.actions).toEqual([]);
    });
  });

  describe("getToolNames", () => {
    it("returns list of available tools", () => {
      const tools = agent.getToolNames();
      
      expect(tools).toContain("readPlan");
      expect(tools).toContain("getTaskHistory");
      expect(tools).toContain("getDiscoveries");
      expect(tools).toContain("getArmStatus");
    });
  });

  describe("executeAction", () => {
    it("returns error for unknown tool", async () => {
      const result = await agent.executeAction("unknownTool", {});
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });
  });
});

describe("BrainAgent - Intent Recognition", () => {
  let db: Database;
  let agent: BrainAgent;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-agent-intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const coleoDir = join(testDir, ".coleo");
    
    await mkdir(join(coleoDir, "db"), { recursive: true });
    
    db = new Database(join(coleoDir, "test.db"));
    db.exec(`PRAGMA journal_mode = WAL;`);

    agent = new BrainAgent({
      db: createSqliteBrainDb(db),
      projectRoot: testDir,
      coleoDir,
    });
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe("next task determination", () => {
    it("recognizes 'what should i do next' query", async () => {
      const result = await agent.invoke({
        messages: [{
          role: "user",
          content: "What should I do next?",
        }],
      });
      
      expect(result.actions).toContainEqual({ tool: "readPlan", input: {} });
      expect(result.actions).toContainEqual({ tool: "getTaskHistory", input: { status: "completed", limit: 10 } });
      expect(result.actions).toContainEqual({ tool: "getDiscoveries", input: {} });
    });

    it("recognizes 'what needs to be done' query", async () => {
      const result = await agent.invoke({
        messages: [{
          role: "user",
          content: "What needs to be done according to the plan?",
        }],
      });
      
      expect(result.actions).toContainEqual({ tool: "readPlan", input: {} });
    });
  });

  describe("arm status queries", () => {
    it("recognizes 'arm status' query", async () => {
      const result = await agent.invoke({
        messages: [{
          role: "user",
          content: "How are the arms doing?",
        }],
      });
      
      expect(result.actions).toContainEqual({ tool: "getArmStatus", input: {} });
    });

    it("recognizes 'status' query", async () => {
      const result = await agent.invoke({
        messages: [{
          role: "user",
          content: "Check the system status",
        }],
      });
      
      expect(result.actions).toContainEqual({ tool: "getArmStatus", input: {} });
    });
  });

  describe("discovery queries", () => {
    it("recognizes 'discovery' query", async () => {
      const result = await agent.invoke({
        messages: [{
          role: "user",
          content: "What discoveries have been found?",
        }],
      });
      
      expect(result.actions).toContainEqual({ tool: "getDiscoveries", input: {} });
    });
  });

  describe("task history queries", () => {
    it("recognizes 'completed tasks' query", async () => {
      const result = await agent.invoke({
        messages: [{
          role: "user",
          content: "What tasks have been completed?",
        }],
      });
      
      expect(result.actions).toContainEqual({ tool: "getTaskHistory", input: { status: "completed", limit: 10 } });
    });
  });
});

describe("BrainAgent - Tool Execution", () => {
  let db: Database;
  let agent: BrainAgent;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-agent-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const coleoDir = join(testDir, ".coleo");
    const projectDir = join(testDir, "project");
    
    await mkdir(join(coleoDir, "db"), { recursive: true });
    await mkdir(join(projectDir, ".project", "plans"), { recursive: true });
    
    db = new Database(join(coleoDir, "test.db"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        domain TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        severity TEXT DEFAULT 'info',
        file_path TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS arms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        current_task_subject TEXT,
        last_activity_at TEXT
      );
    `);

    db.run(`
      INSERT INTO tasks (id, subject, status, domain, completed_at)
      VALUES 
        ('task-1', 'Set up project', 'completed', 'architect', '2026-01-15T10:00:00Z'),
        ('task-2', 'Implement API', 'in_progress', 'backend', null)
    `);

    db.run(`
      INSERT INTO discoveries (id, kind, title, details, severity, status)
      VALUES 
        ('disc-1', 'test_failure', 'Tests failing', 'Unit tests not passing', 'error', 'open')
    `);

    db.run(`
      INSERT INTO arms (id, name, status, current_task_subject, last_activity_at)
      VALUES 
        ('arm-1', 'worker-1', 'busy', 'Implement API', '2026-01-15T11:00:00Z')
    `);

    agent = new BrainAgent({
      db: createSqliteBrainDb(db),
      projectRoot: projectDir,
      coleoDir,
    });
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe("readPlan tool", () => {
    it("returns error when no plan exists", async () => {
      const result = await agent.executeAction("readPlan", {});
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("No plan documents found");
    });
  });

  describe("getTaskHistory tool", () => {
    it("returns completed tasks", async () => {
      const result = await agent.executeAction("getTaskHistory", { status: "completed" });
      
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const tasks = result.data as Array<{ status: string }>;
      expect(tasks.length).toBeGreaterThan(0);
      if (tasks[0]) {
        expect(tasks[0].status).toBe("completed");
      }
    });

    it("returns in_progress tasks", async () => {
      const result = await agent.executeAction("getTaskHistory", { status: "in_progress" });
      
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const tasks = result.data as Array<{ status: string }>;
      expect(tasks.length).toBeGreaterThan(0);
      if (tasks[0]) {
        expect(tasks[0].status).toBe("in_progress");
      }
    });
  });

  describe("getDiscoveries tool", () => {
    it("returns open discoveries", async () => {
      const result = await agent.executeAction("getDiscoveries", {});
      
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const discoveries = result.data as Array<{ severity: string }>;
      expect(discoveries.length).toBeGreaterThan(0);
      if (discoveries[0]) {
        expect(discoveries[0].severity).toBe("error");
      }
    });

    it("filters by severity", async () => {
      const result = await agent.executeAction("getDiscoveries", { severity: ["warning"] });
      
      expect(result.success).toBe(true);
      const discoveries = result.data as Array<{ severity: string }>;
      discoveries.forEach(d => {
        expect(d.severity).toBe("warning");
      });
    });
  });

  describe("getArmStatus tool", () => {
    it("returns all active arms", async () => {
      const result = await agent.executeAction("getArmStatus", {});
      
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const arms = result.data as Array<{ status: string }>;
      expect(arms.length).toBeGreaterThan(0);
      if (arms[0]) {
        expect(arms[0].status).toBe("busy");
      }
    });

    it("filters by specific arm", async () => {
      const result = await agent.executeAction("getArmStatus", { armId: "arm-1" });
      
      expect(result.success).toBe(true);
      const arms = result.data as Array<{ id: string }>;
      expect(arms.length).toBe(1);
      if (arms[0]) {
        expect(arms[0].id).toBe("arm-1");
      }
    });
  });
});
