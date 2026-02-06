/**
 * Brain routes
 *
 * Brain state, control, and management endpoints
 * 
 * NOTE: Brain state is now stored in SQLite (brain_state table), not JSON files.
 */
import { Hono, type Context } from "hono";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcastBrainEvent, broadcastMailEvent } from "../websocket";
import { getColeoDir } from "../../config";
import { join } from "path";
import { mkdir } from "fs/promises";
import { Maildir } from "../../mail/maildir";
import { getBrainState, updateBrainState, type BrainState } from "../../db/state";
import { assignTaskToArm, updateInfrastructureHealth } from "../../db/transactions";

interface BrainContext {
  Variables: {
    db: Database;
    coleoDir: string;
  };
}

interface SqlRequestBody {
  sql: string;
  params: SQLQueryBindings[];
}

interface AssignTaskRequestBody {
  taskId: string;
  armId: string;
  role?: "primary" | "watcher";
  isClaim?: boolean;
}

interface InfrastructureHealthRequestBody {
  components: Array<{
    component: string;
    healthy: boolean;
    optional: boolean;
    error?: string;
  }>;
}

export interface BrainStatus {
  status: "stopped" | "running" | "paused";
  lastPollAt: string | null;
  pollIntervalMs: number;
  activeArmsCount: number;
  pendingTasksCount: number;
  completedToday: number;
  uptime: number | null;
}

// Re-export BrainState for backward compatibility
export type { BrainState } from "../../db/state";

export function createBrainRoutes() {
  const app = new Hono<BrainContext>();

  const parseSqlRequest = async (c: Context<BrainContext>): Promise<SqlRequestBody> => {
    const body = await c.req.json<{ sql?: unknown; params?: unknown }>();
    if (!body?.sql || typeof body.sql !== "string") {
      throw HttpError.badRequest("sql must be a non-empty string");
    }
    if (body.params !== undefined && !Array.isArray(body.params)) {
      throw HttpError.badRequest("params must be an array");
    }
    return { sql: body.sql, params: (body.params || []) as SQLQueryBindings[] };
  };

  app.use("*", async (c, next) => {
    const coleoDir = getColeoDir();
    c.set("coleoDir", coleoDir);
    await next();
  });

  app.get("/status", (c) => {
    const db = c.get("db");

    const brainState = getBrainState(db);

    const activeArmsCount = db.query("SELECT COUNT(*) as count FROM arms WHERE status NOT IN ('stopped', 'error')").get() as { count: number } | null;

    const now = Date.now();
    const startedAt = brainState.startedAt ? new Date(brainState.startedAt).getTime() : null;
    const uptime = startedAt ? Math.floor((now - startedAt) / 1000) : null;

    const status: BrainStatus = {
      status: brainState.status,
      lastPollAt: brainState.lastPollAt || null,
      pollIntervalMs: brainState.pollIntervalMs,
      activeArmsCount: activeArmsCount?.count || 0,
      pendingTasksCount: brainState.pendingTasks,
      completedToday: brainState.completedToday,
      uptime,
    };

    return c.json({ brain: status });
  });

  app.get("/state", (c) => {
    const db = c.get("db");
    const state = getBrainState(db);
    return c.json({ state });
  });

  app.post("/start", (c) => {
    const db = c.get("db");
    const now = new Date().toISOString();

    const currentState = getBrainState(db);
    if (currentState.status === "running") {
      throw HttpError.badRequest("Brain is already running");
    }

    updateBrainState(db, {
      status: "running",
      startedAt: currentState.startedAt || now,
      lastPollAt: now,
    });

    broadcastBrainEvent("started", { status: "running" });

    return c.json({ started: true, status: "running" });
  });

  app.post("/stop", (c) => {
    const db = c.get("db");

    const currentState = getBrainState(db);
    if (currentState.status === "stopped") {
      throw HttpError.badRequest("Brain is already stopped");
    }

    updateBrainState(db, {
      status: "stopped",
      lastPollAt: new Date().toISOString(),
    });

    broadcastBrainEvent("stopped", { status: "stopped" });

    return c.json({ stopped: true, status: "stopped" });
  });

  app.post("/pause", (c) => {
    const db = c.get("db");

    const currentState = getBrainState(db);
    if (currentState.status !== "running") {
      throw HttpError.badRequest("Brain must be running to pause");
    }

    updateBrainState(db, {
      status: "paused",
      lastPollAt: new Date().toISOString(),
    });

    broadcastBrainEvent("paused", { status: "paused" });

    return c.json({ paused: true, status: "paused" });
  });

  app.post("/resume", (c) => {
    const db = c.get("db");

    const currentState = getBrainState(db);
    if (currentState.status !== "paused") {
      throw HttpError.badRequest("Brain must be paused to resume");
    }

    updateBrainState(db, {
      status: "running",
      lastPollAt: new Date().toISOString(),
    });

    broadcastBrainEvent("resumed", { status: "running" });

    return c.json({ resumed: true, status: "running" });
  });

  app.get("/config", (c) => {
    const coleoDir = c.get("coleoDir");
    const db = c.get("db");

    let config: Record<string, string> = {};
    try {
      const rows = db.query("SELECT key, value FROM config").all() as { key: string; value: string }[];
      for (const row of rows) {
        config[row.key] = row.value;
      }
    } catch {
      // Table may not exist yet
    }

    return c.json({
      brain: {
        pollIntervalMs: parseInt(config.brain_poll_interval_ms || "30000", 10),
        maxArms: parseInt(config.brain_max_arms || "8", 10),
        heartbeatTimeoutSeconds: parseInt(config.arm_heartbeat_timeout_seconds || "120", 10),
      },
    });
  });

  app.patch("/config", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      pollIntervalMs?: number;
      maxArms?: number;
    }>();

    if (body.pollIntervalMs !== undefined) {
      db.run("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)", [
        "brain_poll_interval_ms",
        String(body.pollIntervalMs),
        new Date().toISOString(),
      ]);
    }

    if (body.maxArms !== undefined) {
      db.run("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)", [
        "brain_max_arms",
        String(body.maxArms),
        new Date().toISOString(),
      ]);
    }

    broadcastBrainEvent("config_updated", { status: "running", ...body });

    return c.json({ updated: true, changes: body });
  });

  /**
   * Brain callback - called by brain process to notify Observatory of events
   * POST /api/brain/notify
   */
  app.post("/notify", async (c) => {
    const body = await c.req.json<{
      event: "started" | "stopped" | "paused" | "resumed" | "poll";
      status: string;
      pollIntervalMs?: number;
      activeArmsCount?: number;
      pendingTasksCount?: number;
      completedToday?: number;
      uptime?: number;
    }>();

    broadcastBrainEvent(body.event, body);

    return c.json({ notified: true });
  });

  /**
   * Send a message to the brain
   * POST /api/brain/message
   * 
   * This writes to the sent/ maildir which the brain polls for new human messages.
   * The brain will parse the message intent and route to appropriate arms.
   */
  app.post("/message", async (c) => {
    const coleoDir = c.get("coleoDir");
    const body = await c.req.json<{
      message: string;
      priority?: "critical" | "high" | "normal" | "low";
      domain?: string;
      inReplyTo?: string;
      subject?: string;
    }>();

    if (!body.message?.trim()) {
      throw HttpError.badRequest("message is required");
    }

    // Ensure mail directories exist
    const sentDir = join(coleoDir, "mail", "sent");
    await mkdir(sentDir, { recursive: true });
    await mkdir(join(sentDir, "new"), { recursive: true });
    await mkdir(join(sentDir, "cur"), { recursive: true });
    await mkdir(join(sentDir, "tmp"), { recursive: true });

    // Write to sent maildir (brain reads from here)
    const sent = new Maildir(sentDir);
    
    // Use provided subject or extract from first line
    let subject: string;
    if (body.subject) {
      subject = body.subject;
    } else {
      // Extract subject from first line or first 100 chars
      const firstLine = body.message.split("\n")[0]?.trim() || body.message.slice(0, 100).trim();
      subject = firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine;
    }
    
    // Build headers including threading info
    const headers: Record<string, string> = {
      "X-Coleo-Type": "human-message",
      "X-Coleo-Priority": body.priority || "normal",
      ...(body.domain ? { "X-Coleo-Domain": body.domain } : {}),
    };
    
    // Add In-Reply-To header if this is a reply
    if (body.inReplyTo) {
      headers["In-Reply-To"] = body.inReplyTo;
      // Also add References header
      headers["References"] = body.inReplyTo;
    }
    
    const mailMessage = await sent.write({
      from: "human@coleo.local",
      to: "brain@coleo.local",
      subject,
      date: new Date(),
      body: body.message,
      headers,
    });

    // Broadcast that a new message was sent to brain
    broadcastBrainEvent("message_received", {
      messageId: mailMessage.id,
      subject,
      priority: body.priority || "normal",
      domain: body.domain,
    });

    // Also broadcast as mail.sent so mail UIs can refresh
    broadcastMailEvent("sent", {
      messageId: mailMessage.id,
      from: "human@coleo.local",
      to: "brain@coleo.local",
      subject,
    });

    return c.json({ 
      sent: true, 
      messageId: mailMessage.id,
      subject,
    }, 201);
  });

  /**
   * Internal SQL proxy endpoints used by the brain process.
   * SQLite access stays in the API server; brain calls these over HTTP.
   */
  app.post("/internal/sql/run", async (c) => {
    const db = c.get("db");
    const { sql, params } = await parseSqlRequest(c);

    try {
      const result = db.run(sql, params);
      return c.json({
        data: {
          changes: result.changes,
          lastInsertRowid: typeof result.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid ?? null,
        },
      });
    } catch (err) {
      throw HttpError.badRequest(`SQL run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.post("/internal/sql/get", async (c) => {
    const db = c.get("db");
    const { sql, params } = await parseSqlRequest(c);

    try {
      const row = db.query(sql).get(...params);
      return c.json({ data: row ?? null });
    } catch (err) {
      throw HttpError.badRequest(`SQL get failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.post("/internal/sql/all", async (c) => {
    const db = c.get("db");
    const { sql, params } = await parseSqlRequest(c);

    try {
      const rows = db.query(sql).all(...params);
      return c.json({ data: rows });
    } catch (err) {
      throw HttpError.badRequest(`SQL all failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.post("/internal/assign-task", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<AssignTaskRequestBody>();

    if (!body.taskId || !body.armId) {
      throw HttpError.badRequest("taskId and armId are required");
    }

    const result = await assignTaskToArm(
      db,
      body.taskId,
      body.armId,
      body.role || "primary",
      body.isClaim === true
    );

    return c.json({ result });
  });

  app.post("/internal/infrastructure-health", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<InfrastructureHealthRequestBody>();

    if (!Array.isArray(body.components)) {
      throw HttpError.badRequest("components must be an array");
    }

    const result = await updateInfrastructureHealth(db, body.components);
    return c.json({ result });
  });

  return app;
}
