/**
 * Arms routes
 * 
 * CRUD operations for arm profiles + harness control
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { getGlobalHarnessManager } from "../../harness";
import { broadcast } from "../websocket";
import { loadConfig } from "../../config";

interface ArmsContext {
  Variables: {
    db: Database;
  };
}

export interface ArmProfile {
  id: string;
  name: string;
  domain: string;
  harness: string;
  status: "idle" | "busy" | "paused" | "error" | "stopped" | "starting" | "running";
  contextBudget: number;
  currentContextUsed: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  config: Record<string, unknown>;
  pid?: number;
  provider?: string;
  model?: string;
}

export function createArmsRoutes() {
  const app = new Hono<ArmsContext>();

  /**
   * List all arms
   * GET /api/arms
   */
  app.get("/", (c) => {
    const db = c.get("db");
    
    try {
      const rows = db.query(`
        SELECT 
          id, name, domain, harness, status,
          context_budget as contextBudget,
          current_context_used as currentContextUsed,
          created_at as createdAt,
          updated_at as updatedAt,
          last_activity_at as lastActivityAt,
          pid, provider, model,
          config
        FROM arms
        ORDER BY name
      `).all() as ArmRow[];

      const arms = rows.map(parseArmRow);
      return c.json({ arms });
    } catch {
      return c.json({ arms: [] });
    }
  });

  /**
   * Get a single arm
   * GET /api/arms/:id
   */
  app.get("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db.query(`
      SELECT 
        id, name, domain, harness, status,
        context_budget as contextBudget,
        current_context_used as currentContextUsed,
        created_at as createdAt,
        updated_at as updatedAt,
        last_activity_at as lastActivityAt,
        pid, provider, model,
        config
      FROM arms
      WHERE id = ?
    `).get(id) as ArmRow | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    return c.json({ arm: parseArmRow(row) });
  });

  /**
   * Create a new arm
   * POST /api/arms
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<Partial<ArmProfile>>();

    if (!body.name) {
      throw HttpError.badRequest("name is required");
    }

    // Load config for defaults
    const config = await loadConfig();
    const defaults = config.defaults;

    const id = body.id || body.name;
    const now = new Date().toISOString();

    // Use config defaults when not specified
    const harness = body.harness || defaults.harness;
    const provider = body.provider || defaults.provider;
    const model = body.model || defaults.model;
    const contextBudget = body.contextBudget || defaults.contextBudget;

    db.run(`
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      body.name,
      body.domain || "general",
      harness,
      body.status || "starting",
      contextBudget,
      0,
      now,
      now,
      body.pid || null,
      provider,
      model,
      JSON.stringify(body.config || {}),
    ]);

    const arm = {
      id,
      name: body.name,
      domain: body.domain || "general",
      harness,
      status: body.status || "starting",
      contextBudget,
      currentContextUsed: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: null,
      pid: body.pid,
      provider,
      model,
      config: body.config || {},
    };

    // Broadcast arm creation
    broadcast("arms", "arm.created", { arm });

    return c.json({ arm }, 201);
  });

  /**
   * Update an arm
   * PATCH /api/arms/:id
   */
  app.patch("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<Partial<ArmProfile>>();

    // Check arm exists
    const existing = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!existing) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push("name = ?");
      values.push(body.name);
    }
    if (body.domain !== undefined) {
      updates.push("domain = ?");
      values.push(body.domain);
    }
    if (body.harness !== undefined) {
      updates.push("harness = ?");
      values.push(body.harness);
    }
    if (body.status !== undefined) {
      updates.push("status = ?");
      values.push(body.status);
    }
    if (body.contextBudget !== undefined) {
      updates.push("context_budget = ?");
      values.push(body.contextBudget);
    }
    if (body.currentContextUsed !== undefined) {
      updates.push("current_context_used = ?");
      values.push(body.currentContextUsed);
    }
    if (body.pid !== undefined) {
      updates.push("pid = ?");
      values.push(body.pid);
    }
    if (body.provider !== undefined) {
      updates.push("provider = ?");
      values.push(body.provider);
    }
    if (body.model !== undefined) {
      updates.push("model = ?");
      values.push(body.model);
    }
    if (body.config !== undefined) {
      updates.push("config = ?");
      values.push(JSON.stringify(body.config));
    }

    if (updates.length === 0) {
      throw HttpError.badRequest("No fields to update");
    }

    updates.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    db.run(`UPDATE arms SET ${updates.join(", ")} WHERE id = ?`, values as (string | number | null)[]);

    // Fetch updated arm
    const row = db.query(`
      SELECT 
        id, name, domain, harness, status,
        context_budget as contextBudget,
        current_context_used as currentContextUsed,
        created_at as createdAt,
        updated_at as updatedAt,
        last_activity_at as lastActivityAt,
        pid, provider, model,
        config
      FROM arms
      WHERE id = ?
    `).get(id) as ArmRow;

    const arm = parseArmRow(row);

    // Broadcast arm update
    broadcast("arms", "arm.updated", { arm, changes: body });

    return c.json({ arm });
  });

  /**
   * Delete an arm
   * DELETE /api/arms/:id
   */
  app.delete("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const result = db.run("DELETE FROM arms WHERE id = ?", [id]);
    if (result.changes === 0) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Broadcast arm deletion
    broadcast("arms", "arm.deleted", { id });

    return c.json({ deleted: true });
  });

  /**
   * Spawn an arm via harness
   * POST /api/arms/:id/spawn
   */
  app.post("/:id/spawn", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      workdir?: string;
      provider?: string;
      model?: string;
      initialPrompt?: string;
    }>();

    // Get harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if arm exists
    const row = db.query("SELECT id, name, domain, harness, status, provider, model FROM arms WHERE id = ?").get(id) as {
      id: string;
      name: string;
      domain: string;
      harness: string;
      status: string;
      provider: string | null;
      model: string | null;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Check if already running
    if (manager.hasSession(id)) {
      throw HttpError.badRequest(`Arm ${id} is already running`);
    }

    // Load config for defaults
    const config = await loadConfig();
    const defaults = config.defaults;

    // Use body > arm record > config defaults
    const provider = body.provider || row.provider || defaults.provider;
    const model = body.model || row.model || defaults.model;

    try {
      // Spawn via harness
      const session = await manager.spawn(id, row.harness, {
        workdir: body.workdir || process.cwd(),
        provider,
        model,
        initialPrompt: body.initialPrompt,
      });

      // Update database
      const now = new Date().toISOString();
      const pid = manager.getPid(id);
      db.run(
        "UPDATE arms SET status = 'idle', pid = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
        [pid ?? null, now, now, id]
      );

      // Broadcast arm spawned
      broadcast("arms", "arm.spawned", { id, sessionId: session.session.id, pid, status: "idle" });

      return c.json({
        spawned: true,
        sessionId: session.session.id,
        pid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to spawn arm: ${message}`);
    }
  });

  /**
   * Kill an arm's harness session
   * POST /api/arms/:id/kill
   */
  app.post("/:id/kill", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Get harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if arm exists
    const exists = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!exists) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Kill the session
    await manager.kill(id);

    // Update database
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?", [now, id]);

    // Broadcast arm killed
    broadcast("arms", "arm.killed", { id, status: "stopped" });

    return c.json({ killed: true });
  });

  /**
   * Send a prompt to an arm
   * POST /api/arms/:id/prompt
   */
  app.post("/:id/prompt", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{ prompt: string }>();

    if (!body.prompt) {
      throw HttpError.badRequest("prompt is required");
    }

    // Get harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if arm exists
    const exists = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!exists) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Check if has active session
    if (!manager.hasSession(id)) {
      throw HttpError.badRequest(`Arm ${id} is not running`);
    }

    try {
      await manager.sendPrompt(id, body.prompt);
      
      // Update activity timestamp
      const now = new Date().toISOString();
      db.run("UPDATE arms SET status = 'busy', last_activity_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);

      // Broadcast prompt sent
      broadcast("arms", "arm.prompt_sent", { id, status: "busy", promptLength: body.prompt.length });

      return c.json({ sent: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to send prompt: ${message}`);
    }
  });

  /**
   * Get arm's harness state
   * GET /api/arms/:id/state
   */
  app.get("/:id/state", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Get harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if arm exists
    const exists = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!exists) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const state = await manager.getState(id);
    const session = manager.getSession(id);

    return c.json({
      state,
      hasSession: !!session,
      sessionId: session?.session.id,
      pid: session ? manager.getPid(id) : undefined,
      spawnedAt: session?.spawnedAt.toISOString(),
    });
  });

  /**
   * Get arm logs
   * GET /api/arms/:id/logs
   */
  app.get("/:id/logs", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const tail = c.req.query("tail");

    // Get harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if arm exists
    const exists = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!exists) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const logs = await manager.readLogs(id, tail ? { tail: parseInt(tail, 10) } : undefined);
    const size = await manager.getLogSize(id);

    return c.json({
      logs,
      size,
      hasSession: manager.hasSession(id),
    });
  });

  return app;
}

// Internal types for database rows
interface ArmRow {
  id: string;
  name: string;
  domain: string;
  harness: string;
  status: string;
  contextBudget: number;
  currentContextUsed: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  pid: number | null;
  provider: string | null;
  model: string | null;
  config: string;
}

function parseArmRow(row: ArmRow): ArmProfile {
  return {
    ...row,
    status: row.status as ArmProfile["status"],
    pid: row.pid ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    config: JSON.parse(row.config || "{}"),
  };
}
