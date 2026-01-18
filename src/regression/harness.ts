/**
 * Test Harness
 * 
 * Creates isolated Octopai instances for regression testing.
 * Each test gets its own database, directories, and ports.
 */

import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { spawn, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { TestContext, TimingHelper, TestResult, TestScenario } from "./types";

const BASE_PORT = 18000;
let portCounter = 0;

/**
 * Get a unique port for this test
 */
function getNextPort(): number {
  return BASE_PORT + (portCounter++ % 1000);
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
  const baseDir = join("/tmp", `octopai-regression-${runId}`);
  const octopaiDir = join(baseDir, ".octopai");
  const workDir = join(baseDir, "workspace");
  const apiPort = getNextPort();
  const apiKey = `test-key-${runId}`;

  // Create directories
  await mkdir(octopaiDir, { recursive: true });
  await mkdir(join(octopaiDir, "mail", "inbox", "new"), { recursive: true });
  await mkdir(join(octopaiDir, "mail", "inbox", "cur"), { recursive: true });
  await mkdir(join(octopaiDir, "mail", "inbox", "tmp"), { recursive: true });
  await mkdir(join(octopaiDir, "mail", "sent", "new"), { recursive: true });
  await mkdir(join(octopaiDir, "mail", "sent", "cur"), { recursive: true });
  await mkdir(join(octopaiDir, "mail", "sent", "tmp"), { recursive: true });
  await mkdir(join(octopaiDir, "logs"), { recursive: true });
  await mkdir(join(octopaiDir, "mcp"), { recursive: true });
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
  await writeFile(join(octopaiDir, "config.toml"), config);

  const logs: string[] = [];
  const ctx: TestContext = {
    runId,
    octopaiDir,
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
  };

  return ctx;
}

/**
 * Initialize the database for a test context
 */
export async function initTestDatabase(ctx: TestContext): Promise<void> {
  const dbPath = join(ctx.octopaiDir, "octopai.db");
  
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
  
  const proc = spawn({
    cmd: ["bun", "run", "src/cli/index.ts", "serve", "-p", String(ctx.apiPort)],
    cwd: process.cwd(),
    env: {
      ...process.env,
      OCTOPAI_DIR: ctx.octopaiDir,
      OCTOPAI_API_KEY: ctx.apiKey,
      OCTOPAI_DB_PATH: join(ctx.octopaiDir, "octopai.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

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
  
  const args = ["bun", "run", "src/cli/index.ts", "brain", "run", "--clean"];
  if (options?.once) {
    args.push("--once");
  }

  const proc = spawn({
    cmd: args,
    cwd: process.cwd(),
    env: {
      ...process.env,
      OCTOPAI_DIR: ctx.octopaiDir,
      OCTOPAI_API_URL: ctx.apiUrl,
      OCTOPAI_API_KEY: ctx.apiKey,
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
  options?: { domain?: string; prompt?: string }
): Promise<{ id: string; pid?: number }> {
  ctx.timing.mark(`arm_spawn_${name}`);
  
  const res = await fetch(`${ctx.apiUrl}/api/arms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": ctx.apiKey,
    },
    body: JSON.stringify({
      name,
      domain: options?.domain || "general",
      provider: ctx.model.provider,
      model: ctx.model.model,
      prompt: options?.prompt,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to spawn arm: ${error}`);
  }

  const data = await res.json() as { arm: { id: string; pid?: number } };
  ctx.timing.mark(`arm_spawned_${name}`);
  ctx.log(`Arm ${name} spawned (ID: ${data.arm.id})`);
  
  return data.arm;
}

/**
 * Create a task in the database
 */
export async function createTask(
  ctx: TestContext,
  subject: string,
  description: string,
  options?: { domain?: string; priority?: number }
): Promise<string> {
  if (!ctx.db) {
    throw new Error("Database not initialized");
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  ctx.db.run(`
    INSERT INTO tasks (id, subject, description, status, priority, domain, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `, [id, subject, description, options?.priority || 1, options?.domain || null, now, now]);

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
  status: string,
  timeoutMs: number = 60000
): Promise<boolean> {
  if (!ctx.db) {
    throw new Error("Database not initialized");
  }

  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const row = ctx.db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
    
    if (row?.status === status) {
      ctx.timing.mark(`task_${status}_${taskId.slice(0, 8)}`);
      ctx.log(`Task ${taskId.slice(0, 8)} reached status: ${status}`);
      return true;
    }
    
    await Bun.sleep(500);
  }

  ctx.log(`Task ${taskId.slice(0, 8)} did not reach status ${status} within ${timeoutMs}ms (current: unknown)`);
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
  ctx.log("Cleaning up test context...");

  // Kill all processes
  for (const proc of ctx.processes) {
    try {
      proc.kill();
      ctx.log(`Killed ${proc.name} (PID: ${proc.pid})`);
    } catch {
      // Process may already be dead
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
      await rm(join(ctx.octopaiDir, ".."), { recursive: true, force: true });
      ctx.log("Removed test directories");
    } catch {
      // May fail if still in use
    }
  } else {
    ctx.log(`Keeping test directory: ${ctx.octopaiDir}`);
  }
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
