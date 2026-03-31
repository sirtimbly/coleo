/**
 * Spawner Database Operations
 *
 * Database operations for arm state management.
 */

import { join } from "path";
import { mkdir } from "fs/promises";
import { initDatabase, type Database } from "../db";
import type { Arm } from "../types";
import type { SpawnOptions } from "./spawner-types";

/**
 * Get or create database connection (runs migrations)
 */
async function getDatabase(coleoDir: string): Promise<Database> {
  const dbPath = join(coleoDir, "coleo.db");
  return await initDatabase(dbPath);
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ArmRow {
  id: string;
  name: string;
  harness: string;
  status: string;
  pid: number | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  last_activity_at: string | null;
}

/**
 * Create an arm in the database
 */
export async function createArmState(options: SpawnOptions, pid?: number): Promise<Arm> {
  const arm: Arm = {
    id: options.name,
    name: options.name,
    agent: options.agent,
    status: "starting",
    pid,
    startedAt: new Date(),
    provider: options.provider,
    model: options.model,
  };

  const db = await getDatabase(options.coleoDir);
  const now = new Date().toISOString();

  try {
    // Try to insert, or update if exists (upsert)
    db.run(`
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        domain = excluded.domain,
        pid = excluded.pid,
        provider = excluded.provider,
        model = excluded.model,
        updated_at = excluded.updated_at
    `, [
      arm.id,
      arm.name,
      options.domain || "general", // domain
      arm.agent, // harness
      arm.status,
      100000, // context_budget
      0, // current_context_used
      now,
      now,
      arm.pid || null,
      arm.provider || null,
      arm.model || null,
      JSON.stringify({}),
    ]);
  } finally {
    db.close();
  }

  // Also create arm's notes directory (still file-based for notes)
  const notesDir = join(options.coleoDir, "state", "arms", options.name, "notes");
  await mkdir(notesDir, { recursive: true });

  return arm;
}

/**
 * List running arms from database (also updates status based on process state)
 */
export async function listArms(coleoDir: string): Promise<Arm[]> {
  const db = await getDatabase(coleoDir);

  try {
    const rows = db.query(`
      SELECT id, name, harness, status, pid, provider, model, created_at, last_activity_at
      FROM arms
      ORDER BY name
    `).all() as ArmRow[];

    const arms: Arm[] = [];

    for (const row of rows) {
      const arm: Arm = {
        id: row.id,
        name: row.name,
        agent: row.harness,
        status: row.status as Arm["status"],
        pid: row.pid ?? undefined,
        provider: row.provider ?? undefined,
        model: row.model ?? undefined,
        startedAt: new Date(row.created_at),
        lastActivity: row.last_activity_at ? new Date(row.last_activity_at) : undefined,
      };

      // Check if process is still running and update status
      if (arm.pid && arm.status !== "stopped") {
        const running = isProcessRunning(arm.pid);
        if (running) {
          // Process is running - if it was "starting", mark as "idle"
          if (arm.status === "starting") {
            arm.status = "idle";
            db.run("UPDATE arms SET status = ?, updated_at = ? WHERE id = ?", [
              arm.status,
              new Date().toISOString(),
              arm.id,
            ]);
          }
        } else {
          // Process is not running anymore
          arm.status = "stopped";
          db.run("UPDATE arms SET status = ?, updated_at = ? WHERE id = ?", [
            arm.status,
            new Date().toISOString(),
            arm.id,
          ]);
        }
      }

      arms.push(arm);
    }

    return arms;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Update arm status
 */
export async function updateArmStatus(
  coleoDir: string,
  armId: string,
  status: Arm["status"]
): Promise<void> {
  const db = await getDatabase(coleoDir);

  try {
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = ?, last_activity_at = ?, updated_at = ? WHERE id = ?", [
      status,
      now,
      now,
      armId,
    ]);
  } catch (err) {
    console.error(`Failed to update arm ${armId}:`, err);
  } finally {
    db.close();
  }
}

/**
 * Kill an arm (if we have its PID)
 */
export async function killArm(coleoDir: string, armId: string): Promise<boolean> {
  const db = await getDatabase(coleoDir);

  try {
    const row = db.query("SELECT pid FROM arms WHERE id = ?").get(armId) as { pid: number | null } | null;

    if (!row) {
      console.error(`Arm ${armId} not found`);
      return false;
    }

    if (row.pid) {
      try {
        process.kill(row.pid);
        console.log(`Killed arm ${armId} (pid: ${row.pid})`);
      } catch {
        console.log(`Arm ${armId} process already dead`);
      }
    }

    // Update status
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = ?, updated_at = ? WHERE id = ?", ["stopped", now, armId]);

    return true;
  } catch (err) {
    console.error(`Failed to kill arm ${armId}:`, err);
    return false;
  } finally {
    db.close();
  }
}
