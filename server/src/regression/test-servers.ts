/**
 * Test Server Utilities
 * 
 * Server startup and database initialization for tests.
 */

import { join } from "path";
import { spawn, type Subprocess } from "bun";
import type { EventEmitter } from "node:events";
import type { TestContext } from "./types";

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

export function setTaskAutoDiscover(ctx: TestContext, enabled: boolean): void {
  if (!ctx.db) throw new Error("Initialize the test database before updating task discovery");
  ctx.db.run(
    "UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'task_auto_discover'",
    [String(enabled)],
  );
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
export async function startBrain(
  ctx: TestContext,
  options?: { once?: boolean; cycles?: number; intervalMs?: number },
): Promise<Subprocess> {
  ctx.timing.mark("brain_start");
  
  // Note: We do NOT use --clean here because it would kill OpenCode processes
  // from other arms that might already be running. The test environment is
  // already isolated, so there's no need to clean up zombie processes.
  const args = ["bun", "run", join(process.cwd(), "src/cli/index.ts"), "brain", "run"];
  if (options?.once) {
    args.push("--once");
  }
  if (options?.cycles !== undefined) {
    args.push("--cycles", String(options.cycles));
  }
  if (options?.intervalMs !== undefined) {
    args.push("--interval", String(options.intervalMs));
  }

  const proc = spawn({
    cmd: args,
    cwd: ctx.workDir,
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
