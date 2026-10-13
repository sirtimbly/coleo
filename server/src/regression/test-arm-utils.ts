/**
 * Test Arm Utilities
 * 
 * Utilities for spawning arms and managing tasks in tests.
 */

import { randomUUID } from "crypto";
import type { TestContext } from "./types";
import { eventStore } from "../nats/jetstream";

/**
 * Spawn an arm for testing
 */
export async function spawnArm(
  ctx: TestContext,
  name: string,
  options?: {
    domain?: string;
    prompt?: string;
    harness?: string;
    provider?: string;
    model?: string;
  }
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
      provider: options?.provider || ctx.model.provider,
      model: options?.model || ctx.model.model,
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
      provider: options?.provider || ctx.model.provider,
      model: options?.model || ctx.model.model,
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
