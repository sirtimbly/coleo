/**
 * Test Cleanup Utilities
 * 
 * Cleanup and health check utilities for tests.
 */

import { join } from "path";
import { readFile, rm } from "fs/promises";
import type { TestContext } from "./types";
import { eventStore, resetEventStore } from "../nats/jetstream";

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

  await stopRuntimeFromPidFile(ctx, "agent-autostart.pid", "auto-started agent");
  await stopRuntimeFromPidFile(ctx, "nats.pid", "local NATS");

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

async function stopRuntimeFromPidFile(
  ctx: TestContext,
  fileName: string,
  label: string,
): Promise<void> {
  try {
    const content = await readFile(join(ctx.coleoDir, "run", fileName), "utf-8");
    const parsed = JSON.parse(content) as { pid?: number };
    if (typeof parsed.pid === "number") {
      process.kill(parsed.pid, "SIGTERM");
      ctx.log(`Killed ${label} (PID: ${parsed.pid})`);
    }
  } catch {
    // Runtime was not started by this test context or already exited.
  }
}
