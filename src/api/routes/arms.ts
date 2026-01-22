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
import { loadConfig, getOctopaiDir } from "../../config";
import { join } from "path";
import { readFile } from "fs/promises";
import { getArmClient } from "../server";
import { generateSystemPrompt } from "../../arm/prompts";

interface ArmsContext {
  Variables: {
    db: Database;
  };
}

/**
 * Log an activity entry
 */
function logActivity(db: Database, actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO activity (timestamp, actor, action, target, details) VALUES (?, ?, ?, ?, ?)`,
    [now, actor, action, target || null, JSON.stringify(details || {})]
  );
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
  port?: number;
  provider?: string;
  model?: string;
  totalTokens?: number;
  totalCost?: number;
  currentTaskSubject?: string;
  agentId?: string;
  host?: string;
}

export interface ArmTemplate {
  name: string;
  domain: string;
  harness: string;
  contextBudget: number;
  provider?: string;
  model?: string;
  personality?: string;
  convictions?: string[];
  config: Record<string, unknown>;
}

/**
 * Load an arm template from .octopai/arms/
 * Searches by filename first, then by name field inside template files
 */
export async function loadArmTemplate(name: string): Promise<ArmTemplate | null> {
  const octopaiDir = getOctopaiDir();
  const armsDir = join(octopaiDir, "arms");

  // First, try direct filename match
  const directPath = join(armsDir, `${name}.toml`);
  try {
    const content = await readFile(directPath, "utf-8");
    return parseArmTemplate(content);
  } catch {
    // File doesn't exist, try searching by name field
  }

  // Search all .toml files for matching name field
  try {
    const { readdir } = await import("fs/promises");
    const files = await readdir(armsDir);
    for (const file of files) {
      if (!file.endsWith(".toml")) continue;
      try {
        const content = await readFile(join(armsDir, file), "utf-8");
        const nameMatch = content.match(/name\s*=\s*"([^"]*)"/);
        if (nameMatch && nameMatch[1] === name) {
          return parseArmTemplate(content);
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Can't read directory
  }

  return null;
}

/**
 * Parse arm template TOML content
 */
function parseArmTemplate(content: string): ArmTemplate {
  const result: ArmTemplate = {
    name: "",
    domain: "general",
    harness: "opencode-api",
    contextBudget: 100000,
    config: {},
  };

  // Extract values using regex
  const nameMatch = content.match(/name\s*=\s*"([^"]*)"/);
  const domainMatch = content.match(/domain\s*=\s*"([^"]*)"/);
  const harnessMatch = content.match(/harness\s*=\s*"([^"]*)"/);
  const budgetMatch = content.match(/budget\s*=\s*(\d+)/);
  const traitsMatch = content.match(/traits\s*=\s*"([^"]*)"/);
  const convictionsMatch = content.match(/core\s*=\s*\[([^\]]*)\]/);
  const providerMatch = content.match(/provider\s*=\s*"([^"]*)"/);
  const modelMatch = content.match(/model\s*=\s*"([^"]*)"/);

  if (nameMatch && nameMatch[1]) result.name = nameMatch[1];
  if (domainMatch && domainMatch[1]) result.domain = domainMatch[1];
  if (harnessMatch && harnessMatch[1]) result.harness = harnessMatch[1];
  if (budgetMatch && budgetMatch[1]) result.contextBudget = parseInt(budgetMatch[1], 10);
  if (traitsMatch && traitsMatch[1]) result.personality = traitsMatch[1];
  if (convictionsMatch && convictionsMatch[1]) {
    result.convictions = convictionsMatch[1].split(",").map((s) => s.trim().replace(/"/g, ""));
  }
  if (providerMatch && providerMatch[1]) result.provider = providerMatch[1];
  if (modelMatch && modelMatch[1]) result.model = modelMatch[1];

  return result;
}

/**
 * List available arm templates
 */
export async function listArmTemplates(): Promise<string[]> {
  const octopaiDir = getOctopaiDir();
  const armsDir = join(octopaiDir, "arms");

  try {
    const { readdir } = await import("fs/promises");
    const files = await readdir(armsDir);
    return files.filter((f) => f.endsWith(".toml")).map((f) => f.replace(".toml", ""));
  } catch {
    return [];
  }
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
          pid, port, provider, model,
          total_tokens as totalTokens,
          total_cost as totalCost,
          current_task_subject as currentTaskSubject,
          agent_id as agentId,
          host,
          config
        FROM arms
        WHERE NOT (harness = 'manual' AND status = 'idle' AND current_task_subject IS NULL)
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
        pid, port, provider, model,
        total_tokens as totalTokens,
        total_cost as totalCost,
        current_task_subject as currentTaskSubject,
        agent_id as agentId,
        host,
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
    const body = await c.req.json<{
      name: string;
      template?: string;
      domain?: string;
      harness?: string;
      provider?: string;
      model?: string;
      contextBudget?: number;
      config?: Record<string, unknown>;
    }>();

    if (!body.name) {
      throw HttpError.badRequest("name is required");
    }

    // Load template if specified
    let template: ArmTemplate | null = null;
    if (body.template) {
      template = await loadArmTemplate(body.template);
      if (!template) {
        throw HttpError.badRequest(`Template not found: ${body.template}`);
      }
    }

    // Load config for defaults
    const config = await loadConfig();
    const defaults = config.defaults;

    const id = body.name;
    const now = new Date().toISOString();

    // Use template values, then body values, then config defaults
    const harness = body.harness || template?.harness || defaults.harness;
    const provider = body.provider || template?.provider || defaults.provider;
    const model = body.model || template?.model || defaults.model;
    const contextBudget = body.contextBudget || template?.contextBudget || defaults.contextBudget;
    const domain = body.domain || template?.domain || "general";

    db.run(`
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      body.name,
      domain,
      harness,
      "starting",
      contextBudget,
      0,
      now,
      now,
      null,
      provider,
      model,
      JSON.stringify(body.config || template?.config || {}),
    ]);

    // Log activity
    logActivity(db, body.name, "registered", undefined, { domain, harness, provider, model });

    const arm = {
      id,
      name: body.name,
      domain,
      harness,
      status: "starting" as const,
      contextBudget,
      currentContextUsed: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: null,
      pid: undefined,
      provider,
      model,
      config: body.config || template?.config || {},
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
      // Log status change
      logActivity(db, id, "status_changed", undefined, { newStatus: body.status });
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

    // Log activity
    logActivity(db, id, "removed");

    // Broadcast arm deletion
    broadcast("arms", "arm.deleted", { id });

    return c.json({ deleted: true });
  });

  /**
   * Spawn an arm via harness (local) or agent (distributed)
   * POST /api/arms/:id/spawn
   * 
   * When an agent is available with the required capabilities, the arm is spawned
   * on that agent via NATS. Otherwise, falls back to local harness spawning.
   */
  app.post("/:id/spawn", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      workdir?: string;
      provider?: string;
      model?: string;
      initialPrompt?: string;
      preferAgent?: boolean; // Explicitly request agent spawning
      agentId?: string; // Spawn on a specific agent
    }>();

    // Check if arm exists (include port and pid for potential recovery)
    const row = db.query("SELECT id, name, domain, harness, status, provider, model, port, pid, agent_id, host, context_budget FROM arms WHERE id = ?").get(id) as {
      id: string;
      name: string;
      domain: string;
      harness: string;
      status: string;
      provider: string | null;
      model: string | null;
      port: number | null;
      pid: number | null;
      agent_id: string | null;
      host: string | null;
      context_budget: number;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Load config for defaults
    const config = await loadConfig();
    const defaults = config.defaults;

    // Use body > arm record > config defaults
    const provider = body.provider || row.provider || defaults.provider;
    const model = body.model || row.model || defaults.model;

    // Try distributed spawning via ArmClient if available
    const armClient = getArmClient();
    if (armClient) {
      // Find an agent to spawn on
      let agentId = body.agentId;
      
      if (!agentId) {
        // Find the best available agent for this harness
        const bestAgent = armClient.findBestAgent(row.harness);
        if (bestAgent) {
          agentId = bestAgent.agentId;
        }
      }
      
      if (agentId || body.preferAgent) {
        if (!agentId) {
          throw HttpError.badRequest(`No agent available for harness: ${row.harness}`);
        }
        
        // Verify agent exists
        const agent = armClient.getAgent(agentId);
        if (!agent) {
          throw HttpError.badRequest(`Agent not found: ${agentId}`);
        }
        
        // Spawn via agent
        try {
          const response = await armClient.spawnArm(agentId, id, {
            name: row.name,
            domain: row.domain,
            harness: row.harness,
            provider,
            model,
            contextBudget: row.context_budget,
            workDir: body.workdir || process.cwd(),
          });
          
          if (!response.success) {
            throw new Error(response.error || "Agent spawn failed");
          }
          
          // Update database with agent info
          const now = new Date().toISOString();
          db.run(
            "UPDATE arms SET status = 'idle', agent_id = ?, host = ?, pid = ?, port = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
            [agentId, agent.hostname, response.data?.pid ?? null, response.data?.port ?? null, now, now, id]
          );
          
          // Log activity
          logActivity(db, id, "spawned", undefined, { 
            agentId, 
            host: agent.hostname,
            pid: response.data?.pid,
            port: response.data?.port,
            provider, 
            model,
            distributed: true,
          });
          
          // Broadcast arm spawned
          broadcast("arms", "arm.spawned", { 
            id, 
            agentId,
            host: agent.hostname,
            pid: response.data?.pid,
            port: response.data?.port,
            status: "idle",
            distributed: true,
          });
          
          return c.json({
            spawned: true,
            distributed: true,
            agentId,
            host: agent.hostname,
            pid: response.data?.pid,
            port: response.data?.port,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // If explicitly requested agent spawn, fail
          if (body.preferAgent || body.agentId) {
            throw HttpError.internal(`Failed to spawn arm on agent: ${message}`);
          }
          // Otherwise fall back to local spawn
          console.log(`[spawn] Agent spawn failed, falling back to local: ${message}`);
        }
      }
    }

    // Fall back to local harness spawning
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if already running in the harness manager
    if (manager.hasSession(id)) {
      throw HttpError.badRequest(`Arm ${id} is already running`);
    }

    // If arm was stopped but has port/pid, try to recover existing OpenCode server
    if (row.status === "stopped" && row.port && row.pid && row.harness === "opencode-api") {
      const recovered = await manager.recover(id, row.harness, row.port, row.pid);
      if (recovered) {
        // Update database to reflect recovered state
        const now = new Date().toISOString();
        const recoveredSessionId = manager.getSession(id)?.session.id;
        db.run(
          "UPDATE arms SET status = 'idle', session_id = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [recoveredSessionId ?? null, now, now, id]
        );
        
        // Log activity
        logActivity(db, id, "recovered", undefined, { port: row.port, pid: row.pid });
        
        // Broadcast arm recovered
        broadcast("arms", "arm.spawned", { id, recovered: true, pid: row.pid, port: row.port, status: "idle" });
        
        return c.json({
          spawned: true,
          recovered: true,
          sessionId: manager.getSession(id)?.session.id,
          pid: row.pid,
          port: row.port,
        });
      }
      // Recovery failed, continue with fresh spawn
    }

    // Generate system prompt for the arm
    const workdir = body.workdir || process.cwd();
    const systemPrompt = generateSystemPrompt({
      armId: id,
      name: row.name,
      domain: row.domain,
      harness: row.harness,
      workdir,
      provider,
      model,
    });

    // Combine system prompt with any user-provided initial prompt
    const fullInitialPrompt = body.initialPrompt 
      ? `${systemPrompt}\n\n---\n\n## Additional Instructions\n\n${body.initialPrompt}`
      : systemPrompt;

    try {
      // Spawn via harness
      const session = await manager.spawn(id, row.harness, {
        workdir,
        provider,
        model,
        initialPrompt: fullInitialPrompt,
      });

      // Update database
      const now = new Date().toISOString();
      const pid = manager.getPid(id);
      const port = manager.getPort(id);
      db.run(
        "UPDATE arms SET status = 'idle', pid = ?, port = ?, session_id = ?, agent_id = NULL, host = NULL, last_heartbeat = ?, updated_at = ? WHERE id = ?",
        [pid ?? null, port ?? null, session.session.id, now, now, id]
      );

      // Log activity
      logActivity(db, id, "spawned", undefined, { pid: pid ?? undefined, port: port ?? undefined, workdir: body.workdir, provider, model, distributed: false });

      // Broadcast arm spawned
      broadcast("arms", "arm.spawned", { id, sessionId: session.session.id, pid, port, status: "idle", distributed: false });

      return c.json({
        spawned: true,
        distributed: false,
        sessionId: session.session.id,
        pid,
        port,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to spawn arm: ${message}`);
    }
  });

  /**
   * Kill an arm's harness session (local or distributed)
   * POST /api/arms/:id/kill
   */
  app.post("/:id/kill", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists and get agent info
    const row = db.query("SELECT id, agent_id FROM arms WHERE id = ?").get(id) as { id: string; agent_id: string | null } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // If arm is on an agent, kill via ArmClient
    if (row.agent_id) {
      const armClient = getArmClient();
      if (armClient) {
        try {
          const response = await armClient.killArm(id);
          if (!response.success) {
            throw new Error(response.error || "Agent kill failed");
          }
          
          // Update database
          const now = new Date().toISOString();
          db.run("UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, agent_id = NULL, host = NULL, updated_at = ? WHERE id = ?", [now, id]);

          // Log activity
          logActivity(db, id, "killed", undefined, { distributed: true, agentId: row.agent_id });

          // Broadcast arm killed
          broadcast("arms", "arm.killed", { id, status: "stopped", distributed: true });

          return c.json({ killed: true, distributed: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Still try to clean up DB state even if agent kill fails
          const now = new Date().toISOString();
          db.run("UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, agent_id = NULL, host = NULL, updated_at = ? WHERE id = ?", [now, id]);
          console.log(`[kill] Agent kill failed, cleaned up DB state: ${message}`);
        }
      }
    }

    // Kill via local harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Kill the session
    await manager.kill(id);

    // Update database
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?", [now, id]);

    // Log activity
    logActivity(db, id, "killed");

    // Broadcast arm killed
    broadcast("arms", "arm.killed", { id, status: "stopped" });

    return c.json({ killed: true });
  });

  /**
   * Pause an arm
   * POST /api/arms/:id/pause
   */
  app.post("/:id/pause", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists
    const row = db.query("SELECT id, status FROM arms WHERE id = ?").get(id) as { id: string; status: string } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (row.status === "paused") {
      throw HttpError.badRequest(`Arm ${id} is already paused`);
    }

    if (row.status === "stopped") {
      throw HttpError.badRequest(`Cannot pause a stopped arm`);
    }

    // Update database
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = 'paused', updated_at = ? WHERE id = ?", [now, id]);

    // Log activity
    logActivity(db, id, "paused");

    // Broadcast arm paused
    broadcast("arms", "arm.paused", { id, status: "paused" });

    return c.json({ paused: true, status: "paused" });
  });

  /**
   * Resume a paused arm
   * POST /api/arms/:id/resume
   */
  app.post("/:id/resume", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists
    const row = db.query("SELECT id, status FROM arms WHERE id = ?").get(id) as { id: string; status: string } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (row.status !== "paused") {
      throw HttpError.badRequest(`Arm ${id} is not paused (current status: ${row.status})`);
    }

    // Update database
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = 'idle', updated_at = ? WHERE id = ?", [now, id]);

    // Log activity
    logActivity(db, id, "resumed");

    // Broadcast arm resumed
    broadcast("arms", "arm.resumed", { id, status: "idle" });

    return c.json({ resumed: true, status: "idle" });
  });

  /**
   * Update arm metrics (tokens, cost, current task)
   * POST /api/arms/:id/metrics
   */
  app.post("/:id/metrics", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const body = await c.req.json<{
      tokens?: { input?: number; output?: number };
      cost?: number;
      currentTask?: { id: string; subject: string } | null;
    }>();

    // Check if arm exists
    const row = db.query("SELECT id FROM arms WHERE id = ?").get(id) as { id: string } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const now = new Date().toISOString();
    const updates: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];

    if (body.tokens) {
      const currentTokens = db.query("SELECT total_tokens FROM arms WHERE id = ?").get(id) as { total_tokens: number } | null;
      const inputDelta = body.tokens.input || 0;
      const outputDelta = body.tokens.output || 0;
      const newTotal = (currentTokens?.total_tokens || 0) + inputDelta + outputDelta;
      updates.push("total_tokens = ?");
      params.push(newTotal);
    }

    if (body.cost !== undefined) {
      const currentCost = db.query("SELECT total_cost FROM arms WHERE id = ?").get(id) as { total_cost: number } | null;
      const newCost = (currentCost?.total_cost || 0) + body.cost;
      updates.push("total_cost = ?");
      params.push(newCost);
    }

    if (body.currentTask !== undefined) {
      updates.push("current_task_id = ?");
      params.push(body.currentTask?.id || null);
      updates.push("current_task_subject = ?");
      params.push(body.currentTask?.subject || null);
    }

    params.push(id);
    db.run(`UPDATE arms SET ${updates.join(", ")} WHERE id = ?`, params);

    return c.json({ success: true });
  });

  /**
   * Get arm's current context (files, tokens)
   * GET /api/arms/:id/context
   */
  app.get("/:id/context", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db.query(`
      SELECT 
        id, 
        context_budget as contextBudget,
        current_context_used as currentContextUsed
      FROM arms
      WHERE id = ?
    `).get(id) as { id: string; contextBudget: number; currentContextUsed: number } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Get file claims for this arm
    let files: Array<{ path: string; claimedAt: string }> = [];
    try {
      const claims = db.query(`
        SELECT file_path as path, claimed_at as claimedAt
        FROM claims
        WHERE arm_id = ?
        ORDER BY claimed_at DESC
      `).all(id) as Array<{ path: string; claimedAt: string }>;
      files = claims;
    } catch {
      // Claims table may not exist yet
    }

    return c.json({
      context: {
        budget: row.contextBudget,
        used: row.currentContextUsed,
        utilization: row.contextBudget > 0 ? row.currentContextUsed / row.contextBudget : 0,
        files,
      },
    });
  });

  /**
   * Get arm's activity log
   * GET /api/arms/:id/activity
   */
  app.get("/:id/activity", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    // Check if arm exists
    const exists = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!exists) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    try {
      const rows = db.query(`
        SELECT id, timestamp, actor, action, target, details
        FROM activity
        WHERE actor = ?
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `).all(id, limit, offset) as Array<{
        id: number;
        timestamp: string;
        actor: string;
        action: string;
        target: string | null;
        details: string;
      }>;

      const activity = rows.map((row) => ({
        ...row,
        details: JSON.parse(row.details || "{}"),
      }));

      // Get total count
      const countRow = db.query("SELECT COUNT(*) as count FROM activity WHERE actor = ?").get(id) as { count: number };

      return c.json({
        activity,
        pagination: {
          limit,
          offset,
          total: countRow.count,
        },
      });
    } catch {
      return c.json({
        activity: [],
        pagination: { limit, offset, total: 0 },
      });
    }
  });

  /**
   * Send a prompt to an arm
   * POST /api/arms/:id/prompt
   * Body: { prompt: string, interrupt?: boolean }
   * If interrupt is true, sends escape key twice before the prompt to cancel current work
   */
  app.post("/:id/prompt", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{ prompt: string; interrupt?: boolean }>();

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
      await manager.sendPrompt(id, body.prompt, { interrupt: body.interrupt });
      
      // Update activity timestamp
      const now = new Date().toISOString();
      db.run("UPDATE arms SET status = 'busy', last_activity_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);

      // Log activity
      logActivity(db, id, "prompt_received", undefined, { promptLength: body.prompt.length, interrupt: body.interrupt });

      // Broadcast prompt sent
      broadcast("arms", "arm.prompt_sent", { id, status: "busy", promptLength: body.prompt.length, interrupt: body.interrupt });

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
    * Register an arm session (arms call this on startup)
    * POST /api/arms/:id/register
    */
  app.post("/:id/register", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      pid?: number;
      sessionId?: string;
    }>();

    const now = new Date().toISOString();

    // Update the arm record with session info
    db.run(
      "UPDATE arms SET status = 'idle', pid = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
      [body.pid ?? null, now, now, id]
    );

    // Log activity
    logActivity(db, id, "registered", undefined, { pid: body.pid, sessionId: body.sessionId });

    // Broadcast registration
    broadcast("arms", "arm.registered", { id, pid: body.pid, status: "idle" });

    return c.json({ registered: true });
  });

  /**
    * Heartbeat from an arm
    * POST /api/arms/:id/heartbeat
    */
  app.post("/:id/heartbeat", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      status?: "idle" | "busy";
      currentTask?: string;
    }>();

    const now = new Date().toISOString();

    db.run(
      "UPDATE arms SET status = ?, last_heartbeat = ?, last_activity_at = ?, current_task = ?, updated_at = ? WHERE id = ?",
      [body.status || "idle", now, now, body.currentTask || null, now, id]
    );

    return c.json({ heartbeat: true });
  });

  /**
   * Recover/reconnect to an arm's running process
   * POST /api/arms/:id/recover
   * Body: { port: number }
   */
  app.post("/:id/recover", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{ port: number }>();

    if (!body.port) {
      throw HttpError.badRequest("port is required");
    }

    // Get harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if arm exists and get its config
    const arm = db.query("SELECT id, harness, pid FROM arms WHERE id = ?").get(id) as { id: string; harness: string; pid: number | null } | null;
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (!arm.pid) {
      throw HttpError.badRequest(`Arm ${id} has no known PID`);
    }

    // Try to recover
    const success = await manager.recover(id, arm.harness, body.port, arm.pid);

    if (success) {
      // Update status
      const now = new Date().toISOString();
      db.run(
        "UPDATE arms SET status = 'idle', last_heartbeat = ?, updated_at = ? WHERE id = ?",
        [now, now, id]
      );

      // Broadcast recovery
      broadcast("arms", "arm.recovered", { id, status: "idle" });

      // Log activity
      logActivity(db, id, "recovered", undefined, { port: body.port, pid: arm.pid });
    }

    return c.json({ recovered: success });
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

  /**
   * Get arm's current todo list from OpenCode
   * GET /api/arms/:id/todos
   */
  app.get("/:id/todos", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists and get port
    const arm = db.query("SELECT id, port FROM arms WHERE id = ?").get(id) as { id: string; port: number | null } | null;
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (!arm.port) {
      return c.json({ todos: [], error: "Arm has no active server" });
    }

    // Get the harness manager to find the session
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    const session = manager.getSession(id);
    if (!session) {
      return c.json({ todos: [], error: "No active session" });
    }

    // Get the OpenCode session ID from the harness session
    const apiSession = session.session as { sessionId?: string };
    const opencodeSessionId = apiSession.sessionId;

    if (!opencodeSessionId) {
      return c.json({ todos: [], error: "No OpenCode session found" });
    }

    // Fetch todos from OpenCode
    try {
      const response = await fetch(`http://127.0.0.1:${arm.port}/session/${opencodeSessionId}/todo`);
      if (!response.ok) {
        return c.json({ todos: [], error: `Failed to fetch todos: ${response.statusText}` });
      }

      const todos = await response.json();
      return c.json({ todos });
    } catch (err) {
      return c.json({ todos: [], error: `Failed to connect to OpenCode: ${err}` });
    }
  });

  /**
   * Get arm's detailed status from OpenCode
   * GET /api/arms/:id/status
   */
  app.get("/:id/status", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists and get port
    const arm = db.query("SELECT id, port, status FROM arms WHERE id = ?").get(id) as { id: string; port: number | null; status: string } | null;
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (!arm.port) {
      return c.json({ 
        status: arm.status,
        opencodeStatus: null,
        error: "Arm has no active server" 
      });
    }

    // Get the harness manager to find the session
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    const session = manager.getSession(id);
    if (!session) {
      return c.json({ 
        status: arm.status,
        opencodeStatus: null,
        error: "No active session" 
      });
    }

    // Get the OpenCode session ID from the harness session
    const apiSession = session.session as { sessionId?: string };
    const opencodeSessionId = apiSession.sessionId;

    // Fetch status from OpenCode
    try {
      const response = await fetch(`http://127.0.0.1:${arm.port}/session/status`);
      if (!response.ok) {
        return c.json({ 
          status: arm.status,
          opencodeStatus: null,
          error: `Failed to fetch status: ${response.statusText}` 
        });
      }

      const statuses = await response.json() as Record<string, { status: string; error?: string }>;
      const opencodeStatus = opencodeSessionId ? statuses[opencodeSessionId] : null;

      return c.json({ 
        status: arm.status,
        opencodeStatus,
        sessionId: opencodeSessionId,
      });
    } catch (err) {
      return c.json({ 
        status: arm.status,
        opencodeStatus: null,
        error: `Failed to connect to OpenCode: ${err}` 
      });
    }
  });

  /**
   * Get arm's conversation messages from OpenCode
   * GET /api/arms/:id/messages
   */
  app.get("/:id/messages", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const limit = parseInt(c.req.query("limit") || "50", 10);

    // Check if arm exists and get port
    const arm = db.query("SELECT id, port FROM arms WHERE id = ?").get(id) as { id: string; port: number | null } | null;
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (!arm.port) {
      return c.json({ messages: [], error: "Arm has no active server" });
    }

    // Get the harness manager to find the session
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    const session = manager.getSession(id);
    if (!session) {
      return c.json({ messages: [], error: "No active session" });
    }

    // Get the OpenCode session ID from the harness session
    const apiSession = session.session as { sessionId?: string };
    const opencodeSessionId = apiSession.sessionId;

    if (!opencodeSessionId) {
      return c.json({ messages: [], error: "No OpenCode session found" });
    }

    // Fetch messages from OpenCode
    try {
      const response = await fetch(`http://127.0.0.1:${arm.port}/session/${opencodeSessionId}/message?limit=${limit}`);
      if (!response.ok) {
        return c.json({ messages: [], error: `Failed to fetch messages: ${response.statusText}` });
      }

      const messages = await response.json();
      return c.json({ messages, sessionId: opencodeSessionId });
    } catch (err) {
      return c.json({ messages: [], error: `Failed to connect to OpenCode: ${err}` });
    }
  });

  /**
   * Stream arm events via SSE (proxy to OpenCode's /event endpoint)
   * GET /api/arms/:id/events
   */
  app.get("/:id/events", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists and get port
    const arm = db.query("SELECT id, port FROM arms WHERE id = ?").get(id) as { id: string; port: number | null } | null;
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (!arm.port) {
      throw HttpError.badRequest("Arm has no active server");
    }

    // Set up SSE headers
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    // Create a readable stream that proxies OpenCode events
    const opencodeUrl = `http://127.0.0.1:${arm.port}/event`;
    
    return c.body(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let aborted = false;
          
          try {
            const response = await fetch(opencodeUrl);
            if (!response.ok || !response.body) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Failed to connect to OpenCode" })}\n\n`));
              controller.close();
              return;
            }

            const reader = response.body.getReader();
            
            // Send initial connection event
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", armId: id })}\n\n`));
            
            while (!aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              
              // Forward the SSE data as-is
              controller.enqueue(value);
            }
            
            reader.releaseLock();
          } catch (err) {
            if (!aborted) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: errorMsg })}\n\n`));
            }
          } finally {
            if (!aborted) {
              controller.close();
            }
          }
        },
        cancel() {
          // Client disconnected
        }
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  });

  /**
   * Get stored arm events (for MCP servers)
   * GET /api/arms/:id/stored-events
   */
  app.get("/:id/stored-events", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists
    const arm = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Get query parameters
    const limit = parseInt(c.req.query("limit") || "50");
    const since = c.req.query("since"); // ISO timestamp
    const eventType = c.req.query("type"); // Filter by event type

    // Build query
    let query = "SELECT event_type, event_data, timestamp FROM arm_events WHERE arm_id = ?";
    let params: any[] = [id];

    if (since) {
      query += " AND timestamp > ?";
      params.push(since);
    }

    if (eventType) {
      query += " AND event_type = ?";
      params.push(eventType);
    }

    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(Math.min(limit, 1000)); // Cap at 1000 events

    // Execute query
    const events = db.query(query).all(...params) as Array<{
      event_type: string;
      event_data: string;
      timestamp: string;
    }>;

    // Parse event data and return
    const parsedEvents = events.map(row => ({
      type: row.event_type,
      data: JSON.parse(row.event_data),
      timestamp: row.timestamp,
    }));

    return c.json({
      armId: id,
      events: parsedEvents,
      count: parsedEvents.length,
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
  port: number | null;
  provider: string | null;
  model: string | null;
  totalTokens: number | null;
  totalCost: number | null;
  currentTaskSubject: string | null;
  agentId: string | null;
  host: string | null;
  config: string;
}

function parseArmRow(row: ArmRow): ArmProfile {
  return {
    ...row,
    status: row.status as ArmProfile["status"],
    pid: row.pid ?? undefined,
    port: row.port ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    totalTokens: row.totalTokens ?? 0,
    totalCost: row.totalCost ?? 0,
    currentTaskSubject: row.currentTaskSubject ?? undefined,
    agentId: row.agentId ?? undefined,
    host: row.host ?? undefined,
    config: JSON.parse(row.config || "{}"),
  };
}
