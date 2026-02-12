/**
 * Test Harness
 * 
 * Creates isolated Coleo instances for regression testing.
 * Each test gets its own database, directories, and ports.
 */

import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { spawn, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { createServer } from "node:net";
import type { EventEmitter } from "node:events";
import type { TestContext, TimingHelper, TestResult, TestScenario } from "./types";
import { eventStore, setEventStore, resetEventStore, createTestEventStore, type InMemoryEventStore } from "../nats/jetstream";

const BASE_PORT = 18000;
let portCounter = 0;

/**
 * Get a unique port for this test
 */
async function getNextPort(): Promise<number> {
  const maxAttempts = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    const port = BASE_PORT + (portCounter++ % 10000);
    const available = await isPortAvailable(port);
    if (available) return port;
  }

  // Fallback: ask OS for any free port
  return await new Promise<number>((resolve, reject) => {
    const server = createServer() as unknown as EventEmitter & { listen(port: number, host: string, cb: () => void): void; address(): { port: number } | string; close(cb: (err?: Error) => void): void };
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : undefined;
      server.close((closeErr?: Error) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate dynamic port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer() as unknown as EventEmitter & { listen(port: number, host: string): void; close(cb: () => void): void };

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

/**
 * Create a timing helper
 */
function createTimingHelper(): TimingHelper {
  const marks: Record<string, number> = {};
  const startTime = Date.now();
  marks["_start"] = startTime;

  return {
    mark: (name: string) => {
      marks[name] = Date.now();
    },
    duration: (from?: string, to?: string) => {
      const fromTime = from ? (marks[from] ?? startTime) : startTime;
      const toTime = to ? (marks[to] ?? Date.now()) : Date.now();
      return toTime - fromTime;
    },
    all: () => {
      const result: Record<string, number> = {};
      for (const [name, time] of Object.entries(marks)) {
        if (name !== "_start") {
          result[name] = time - startTime;
        }
      }
      return result;
    },
  };
}

/**
 * Create an isolated test context
 */
export async function createTestContext(
  model: { provider: string; model: string },
  options?: { keepAfterTest?: boolean }
): Promise<TestContext> {
  const runId = randomUUID().slice(0, 8);
  const baseDir = join("/tmp", `coleo-regression-${runId}`);
  const coleoDir = join(baseDir, ".coleo");
  const workDir = join(baseDir, "workspace");
  const apiPort = await getNextPort();
  const apiKey = `test-key-${runId}`;

  // Set up in-memory event store for isolated testing
  const testEventStore = createTestEventStore();
  setEventStore(testEventStore);

  // Create directories
  await mkdir(coleoDir, { recursive: true });
  await mkdir(join(coleoDir, "mail", "inbox", "new"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "inbox", "cur"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "inbox", "tmp"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "sent", "new"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "sent", "cur"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "sent", "tmp"), { recursive: true });
  await mkdir(join(coleoDir, "logs"), { recursive: true });
  await mkdir(join(coleoDir, "mcp"), { recursive: true });
  await mkdir(workDir, { recursive: true });

  // Create config file
  const config = `
[brain]
poll_interval_ms = 5000
verbose = true

[api]
port = ${apiPort}
api_key = "${apiKey}"

[model]
provider = "${model.provider}"
model = "${model.model}"
`;
  await writeFile(join(coleoDir, "config.toml"), config);

  const logs: string[] = [];
  const ctx: TestContext = {
    runId,
    coleoDir,
    workDir,
    apiPort,
    apiUrl: `http://localhost:${apiPort}`,
    apiKey,
    model,
    log: (message: string) => {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] ${message}`;
      logs.push(line);
      console.log(`[${runId}] ${message}`);
    },
    timing: createTimingHelper(),
    processes: [],
    arms: [],
  };

  return ctx;
}

/**
 * Initialize the database for a test context
 */
export async function initTestDatabase(ctx: TestContext): Promise<void> {
  const dbPath = join(ctx.coleoDir, "coleo.db");
  
  // Import and run database initialization
  const { initDatabase } = await import("../db");
  ctx.db = await initDatabase(dbPath);
  
  ctx.log("Database initialized");
}

/**
 * Start the API server for a test context
 */
export async function startApiServer(ctx: TestContext): Promise<void> {
  ctx.timing.mark("api_start");
  
  ctx.log(`Starting API server with key: ${ctx.apiKey.slice(0, 16)}...`);
  
  const proc = spawn({
    cmd: ["bun", "run", "src/cli/index.ts", "serve", "-p", String(ctx.apiPort)],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COLEO_DIR: ctx.coleoDir,
      COLEO_API_KEY: ctx.apiKey,
      COLEO_API_PORT: String(ctx.apiPort),
      COLEO_DB_PATH: join(ctx.coleoDir, "coleo.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream output to console for debugging
  const streamOutput = async (stream: ReadableStream, prefix: string) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            console.log(`[${prefix}] ${line}`);
          }
        }
      }
    } catch {
      // Ignore stream errors
    }
  };

  streamOutput(proc.stdout, "API");
  streamOutput(proc.stderr, "API-ERR");

  ctx.processes.push({
    pid: proc.pid,
    name: "api-server",
    kill: () => proc.kill(),
  });

  // Wait for server to be ready
  const maxWait = 10000;
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    try {
      const res = await fetch(`${ctx.apiUrl}/api/health`);
      if (res.ok) {
        ctx.timing.mark("api_ready");
        ctx.log(`API server ready on port ${ctx.apiPort}`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await Bun.sleep(100);
  }

  throw new Error(`API server failed to start within ${maxWait}ms`);
}

/**
 * Start the brain for a test context
 */
export async function startBrain(ctx: TestContext, options?: { once?: boolean }): Promise<Subprocess> {
  ctx.timing.mark("brain_start");
  
  // Note: We do NOT use --clean here because it would kill OpenCode processes
  // from other arms that might already be running. The test environment is
  // already isolated, so there's no need to clean up zombie processes.
  const args = ["bun", "run", "src/cli/index.ts", "brain", "run"];
  if (options?.once) {
    args.push("--once");
  }

  const proc = spawn({
    cmd: args,
    cwd: process.cwd(),
    env: {
      ...process.env,
      COLEO_DIR: ctx.coleoDir,
      COLEO_API_URL: ctx.apiUrl,
      COLEO_API_KEY: ctx.apiKey,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  ctx.processes.push({
    pid: proc.pid,
    name: "brain",
    kill: () => proc.kill(),
  });

  ctx.log(`Brain started (PID: ${proc.pid})`);
  return proc;
}

/**
 * Spawn an arm for testing
 */
export async function spawnArm(
  ctx: TestContext,
  name: string,
  options?: { domain?: string; prompt?: string; harness?: string }
): Promise<{ id: string; pid?: number; port?: number }> {
  ctx.timing.mark(`arm_spawn_${name}`);
  
  // Step 1: Create the arm record
  const createRes = await fetch(`${ctx.apiUrl}/api/arms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": ctx.apiKey,
    },
    body: JSON.stringify({
      name,
      domain: options?.domain || "general",
      harness: options?.harness || "opencode-api",
      provider: ctx.model.provider,
      model: ctx.model.model,
      prompt: options?.prompt,
    }),
  });

  if (!createRes.ok) {
    const error = await createRes.text();
    throw new Error(`Failed to create arm: ${error}`);
  }

  const createData = await createRes.json() as { arm: { id: string } };
  const armId = createData.arm.id;
  ctx.log(`Arm ${name} created (ID: ${armId})`);

  // Step 2: Spawn the arm (start the harness process)
  const spawnRes = await fetch(`${ctx.apiUrl}/api/arms/${armId}/spawn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": ctx.apiKey,
    },
    body: JSON.stringify({
      workdir: ctx.workDir,
      provider: ctx.model.provider,
      model: ctx.model.model,
      initialPrompt: options?.prompt,
    }),
  });

  if (!spawnRes.ok) {
    const error = await spawnRes.text();
    throw new Error(`Failed to spawn arm: ${error}`);
  }

  const spawnData = await spawnRes.json() as { spawned: boolean; pid?: number; port?: number };
  ctx.timing.mark(`arm_spawned_${name}`);
  ctx.log(`Arm ${name} spawned (PID: ${spawnData.pid}, Port: ${spawnData.port})`);
  
  // Wait for MCP servers to connect (give it a few seconds)
  if (spawnData.port) {
    const mcpUrl = `http://localhost:${spawnData.port}/mcp`;
    let mcpConnected = false;
    const mcpStartTime = Date.now();
    const mcpTimeout = 10000; // 10 seconds
    
    while (Date.now() - mcpStartTime < mcpTimeout && !mcpConnected) {
      try {
        const mcpRes = await fetch(mcpUrl);
        if (mcpRes.ok) {
          const mcpStatus = await mcpRes.json() as Record<string, { status: string }>;
          if (mcpStatus.coleo?.status === "connected") {
            mcpConnected = true;
            ctx.log("MCP coleo server connected");
          } else {
            ctx.log(`MCP status: ${JSON.stringify(mcpStatus.coleo)}`);
          }
        }
      } catch {
        // Server not ready yet
      }
      if (!mcpConnected) {
        await Bun.sleep(500);
      }
    }
    
    if (!mcpConnected) {
      ctx.log(`Warning: MCP coleo server did not connect within ${mcpTimeout}ms`);
    }
  }
  
  // Track arm for cleanup
  const armInfo = { id: armId, pid: spawnData.pid, port: spawnData.port };
  ctx.arms.push(armInfo);
  
  return armInfo;
}

/**
 * Create a task in the database
 */
export async function createTask(
  ctx: TestContext,
  subject: string,
  description: string,
  options?: { domain?: string; priority?: 'critical' | 'high' | 'normal' | 'low' }
): Promise<string> {
  if (!ctx.db) {
    throw new Error("Database not initialized");
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  ctx.db.run(`
    INSERT INTO tasks (id, subject, description, status, priority, domain, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `, [id, subject, description, options?.priority || 'normal', options?.domain || null, now, now]);

  ctx.timing.mark(`task_created_${id.slice(0, 8)}`);
  ctx.log(`Task created: ${subject} (ID: ${id.slice(0, 8)})`);
  
  return id;
}

/**
 * Wait for a task to reach a specific status
 */
export async function waitForTaskStatus(
  ctx: TestContext,
  taskId: string,
  status: string | string[],
  timeoutMs: number = 60000
): Promise<boolean> {
  if (!ctx.db) {
    throw new Error("Database not initialized");
  }

  const targetStatuses = Array.isArray(status) ? status : [status];
  const startTime = Date.now();
  let lastLogTime = 0;
  let lastStatus = "";
  
  while (Date.now() - startTime < timeoutMs) {
    const row = ctx.db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
    
    if (row?.status && targetStatuses.includes(row.status)) {
      ctx.timing.mark(`task_${row.status}_${taskId.slice(0, 8)}`);
      ctx.log(`Task ${taskId.slice(0, 8)} reached status: ${row.status}`);
      return true;
    }
    
    // Log status changes and periodic activity
    if (row?.status !== lastStatus) {
      ctx.log(`Task ${taskId.slice(0, 8)} status changed: ${lastStatus || "none"} -> ${row?.status || "unknown"}`);
      lastStatus = row?.status || "";
    }
    
    // Every 10 seconds, dump recent activity for debugging
      const now = Date.now();
      if (now - lastLogTime > 10000) {
        lastLogTime = now;
        try {
          // Use in-memory event store (set up in createTestContext)
          if (eventStore.isInitialized()) {
            const events = await eventStore.getRecentEvents(5);
            const activities = events.map(e => ({
              timestamp: e.timestamp,
              actor: e.armId || "unknown",
              action: e.type || "unknown",
              target: (e.data?.target as string) || (e.data?.taskId as string) || null,
            }));
            
            if (activities.length > 0) {
              const elapsed = Math.round((now - startTime) / 1000);
              ctx.log(`[${elapsed}s] Recent activity:`);
              for (const a of activities.reverse()) {
                ctx.log(`  ${a.actor}: ${a.action}${a.target ? ` [${a.target.slice(0, 8)}]` : ""}`);
              }
            }
          }
        } catch {
          // Ignore activity log errors
        }
      }
    
    await Bun.sleep(500);
  }

  // Get the final status for logging
  const finalRow = ctx.db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
  ctx.log(`Task ${taskId.slice(0, 8)} did not reach status ${targetStatuses.join(" or ")} within ${timeoutMs}ms (current: ${finalRow?.status ?? "not found"})`);
  return false;
}

/**
 * Wait for an arm to reach a specific status
 */
export async function waitForArmStatus(
  ctx: TestContext,
  armId: string,
  status: string,
  timeoutMs: number = 30000
): Promise<boolean> {
  if (!ctx.db) {
    throw new Error("Database not initialized");
  }

  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const row = ctx.db.query("SELECT status FROM arms WHERE id = ?").get(armId) as { status: string } | null;
    
    if (row?.status === status) {
      ctx.timing.mark(`arm_${status}_${armId.slice(0, 8)}`);
      ctx.log(`Arm ${armId.slice(0, 8)} reached status: ${status}`);
      return true;
    }
    
    await Bun.sleep(500);
  }

  return false;
}

/**
 * Check infrastructure health via API
 */
export async function checkInfraHealth(ctx: TestContext): Promise<boolean> {
  try {
    const res = await fetch(`${ctx.apiUrl}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Clean up a test context
 */
export async function cleanupTestContext(ctx: TestContext, options?: { keep?: boolean }): Promise<void> {
  // Dump activity log for debugging
  if (ctx.db) {
    try {
      // Use in-memory event store (set up in createTestContext)
      if (eventStore.isInitialized()) {
        const events = await eventStore.getRecentEvents(20);
        const activities = events.map(e => ({
          timestamp: e.timestamp,
          actor: e.armId || "unknown",
          action: e.type || "unknown",
          target: (e.data?.target as string) || (e.data?.taskId as string) || null,
        }));
        
        if (activities.length > 0) {
          ctx.log("=== Recent Activity (last 20) ===");
          for (const a of activities.reverse()) {
            ctx.log(`  ${a.timestamp} ${a.actor}: ${a.action}${a.target ? ` [${a.target.slice(0, 8)}]` : ""}`);
          }
          ctx.log("=================================");
        }
      }
    } catch {
      // Ignore activity log errors
    }
  }
  
  ctx.log("Cleaning up test context...");

  // Kill all arms first (OpenCode servers and their child processes)
  for (const arm of ctx.arms) {
    // Kill via API if available
    try {
      await fetch(`${ctx.apiUrl}/api/arms/${arm.id}/kill`, {
        method: "POST",
        headers: { "X-API-Key": ctx.apiKey },
      });
      ctx.log(`Killed arm ${arm.id} via API`);
    } catch {
      // API may not be running, fall back to direct kill
    }
    
    // Also kill by PID directly to ensure cleanup
    if (arm.pid) {
      try {
        // Kill the process group to catch child processes (MCP servers)
        process.kill(-arm.pid, "SIGTERM");
        ctx.log(`Killed arm ${arm.id} process group (PID: ${arm.pid})`);
      } catch {
        // Try regular kill
        try {
          process.kill(arm.pid, "SIGKILL");
          ctx.log(`Force killed arm ${arm.id} (PID: ${arm.pid})`);
        } catch {
          // Process may already be dead
        }
      }
    }
  }

  // Kill all tracked processes
  for (const proc of ctx.processes) {
    try {
      proc.kill();
      ctx.log(`Killed ${proc.name} (PID: ${proc.pid})`);
    } catch {
      // Process may already be dead
    }
  }
  
  // Give processes a moment to die
  await Bun.sleep(500);
  
  // Force kill any remaining processes by PID
  for (const proc of ctx.processes) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }
  for (const arm of ctx.arms) {
    if (arm.pid) {
      try {
        process.kill(arm.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
  }

  // Close database
  if (ctx.db) {
    try {
      ctx.db.close();
    } catch {
      // May already be closed
    }
  }

  // Remove directories unless keeping for debugging
  if (!options?.keep) {
    try {
      await rm(join(ctx.coleoDir, ".."), { recursive: true, force: true });
      ctx.log("Removed test directories");
    } catch {
      // May fail if still in use
    }
  } else {
    ctx.log(`Keeping test directory: ${ctx.coleoDir}`);
  }

  // Reset event store to default (JetStream-backed) for non-test code
  resetEventStore();
}

/**
 * Run a single test scenario
 */
export async function runScenario(
  scenario: TestScenario,
  model: { provider: string; model: string },
  options?: { keepOnFailure?: boolean }
): Promise<TestResult> {
  const ctx = await createTestContext(model);
  const startedAt = new Date();
  
  ctx.log(`Starting scenario: ${scenario.name}`);
  ctx.timing.mark("scenario_start");

  let result: TestResult;
  let keepContext = false;

  try {
    // Run setup
    if (scenario.setup) {
      await scenario.setup(ctx);
    }

    // Run the test
    result = await Promise.race([
      scenario.run(ctx),
      new Promise<TestResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Scenario timeout after ${scenario.timeout}ms`)), scenario.timeout)
      ),
    ]);

    // Run evaluation if provided
    if (scenario.evaluate) {
      result = await scenario.evaluate(ctx, result);
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.log(`Scenario failed: ${errorMsg}`);
    
    result = {
      runId: ctx.runId,
      scenario: scenario.name,
      passed: false,
      error: errorMsg,
      timing: {
        total: ctx.timing.duration(),
        ...ctx.timing.all(),
      },
      model: ctx.model,
      startedAt,
      endedAt: new Date(),
    };

    if (options?.keepOnFailure) {
      keepContext = true;
    }
  } finally {
    // Run teardown
    if (scenario.teardown) {
      try {
        await scenario.teardown(ctx);
      } catch (error) {
        ctx.log(`Teardown error: ${error}`);
      }
    }

    await cleanupTestContext(ctx, { keep: keepContext });
  }

  ctx.timing.mark("scenario_end");
  result.timing.total = ctx.timing.duration();
  result.endedAt = new Date();

  ctx.log(`Scenario ${result.passed ? "PASSED" : "FAILED"} in ${result.timing.total}ms`);
  
  return result;
}
