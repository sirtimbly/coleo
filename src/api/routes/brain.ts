/**
 * Brain routes
 *
 * Brain state, control, and management endpoints
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcastBrainEvent } from "../websocket";
import { getOctopaiDir } from "../../config";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { Maildir } from "../../mail/maildir";

interface BrainContext {
  Variables: {
    db: Database;
    octopaiDir: string;
  };
}

export interface BrainState {
  status: "stopped" | "running" | "paused";
  pollIntervalMs: number;
  activeArms: string[];
  pendingTasks: number;
  completedToday: number;
  lastPollAt?: string;
  startedAt?: string;
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

export function createBrainRoutes() {
  const app = new Hono<BrainContext>();

  app.use("*", async (c, next) => {
    const octopaiDir = getOctopaiDir();
    c.set("octopaiDir", octopaiDir);
    await next();
  });

  app.get("/status", async (c) => {
    const octopaiDir = c.get("octopaiDir");
    const db = c.get("db");

    let brainState: Partial<BrainState> = {
      status: "stopped",
      pollIntervalMs: 30000,
      activeArms: [],
      pendingTasks: 0,
      completedToday: 0,
    };

    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      brainState = { ...brainState, ...JSON.parse(content) };
    } catch {
      // No state file, use defaults
    }

    const activeArmsCount = db.query("SELECT COUNT(*) as count FROM arms WHERE status NOT IN ('stopped', 'error')").get() as { count: number } | null;
    const pendingTasksCount = brainState.pendingTasks || 0;

    const now = Date.now();
    const startedAt = brainState.startedAt ? new Date(brainState.startedAt).getTime() : null;
    const uptime = startedAt ? Math.floor((now - startedAt) / 1000) : null;

    const status: BrainStatus = {
      status: (brainState.status as BrainStatus["status"]) || "stopped",
      lastPollAt: brainState.lastPollAt || null,
      pollIntervalMs: brainState.pollIntervalMs || 30000,
      activeArmsCount: activeArmsCount?.count || 0,
      pendingTasksCount,
      completedToday: brainState.completedToday || 0,
      uptime,
    };

    return c.json({ brain: status });
  });

  app.get("/state", async (c) => {
    const octopaiDir = c.get("octopaiDir");

    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      return c.json({ state: JSON.parse(content) });
    } catch {
      return c.json({ state: null });
    }
  });

  app.post("/start", async (c) => {
    const octopaiDir = c.get("octopaiDir");

    const now = new Date().toISOString();

    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);
      if (state.status === "running") {
        throw HttpError.badRequest("Brain is already running");
      }
      state.status = "running";
      state.startedAt = state.startedAt || now;
      state.lastPollAt = now;
      await writeFile(join(octopaiDir, "state", "brain.json"), JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const newState = {
        status: "running",
        pollIntervalMs: 30000,
        activeArms: [],
        pendingTasks: 0,
        completedToday: 0,
        startedAt: now,
        lastPollAt: now,
      };
      await writeFile(join(octopaiDir, "state", "brain.json"), JSON.stringify(newState, null, 2), "utf-8");
    }

    broadcastBrainEvent("started", { status: "running" });

    return c.json({ started: true, status: "running" });
  });

  app.post("/stop", async (c) => {
    const octopaiDir = c.get("octopaiDir");

    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);
      if (state.status === "stopped") {
        throw HttpError.badRequest("Brain is already stopped");
      }
      state.status = "stopped";
      state.lastPollAt = new Date().toISOString();
      await writeFile(join(octopaiDir, "state", "brain.json"), JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      if (err instanceof HttpError) throw err;
    }

    broadcastBrainEvent("stopped", { status: "stopped" });

    return c.json({ stopped: true, status: "stopped" });
  });

  app.post("/pause", async (c) => {
    const octopaiDir = c.get("octopaiDir");

    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);
      if (state.status !== "running") {
        throw HttpError.badRequest("Brain must be running to pause");
      }
      state.status = "paused";
      state.lastPollAt = new Date().toISOString();
      await writeFile(join(octopaiDir, "state", "brain.json"), JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.badRequest("Brain is not running");
    }

    broadcastBrainEvent("paused", { status: "paused" });

    return c.json({ paused: true, status: "paused" });
  });

  app.post("/resume", async (c) => {
    const octopaiDir = c.get("octopaiDir");

    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);
      if (state.status !== "paused") {
        throw HttpError.badRequest("Brain must be paused to resume");
      }
      state.status = "running";
      state.lastPollAt = new Date().toISOString();
      await writeFile(join(octopaiDir, "state", "brain.json"), JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.badRequest("Brain is not paused");
    }

    broadcastBrainEvent("resumed", { status: "running" });

    return c.json({ resumed: true, status: "running" });
  });

  app.get("/config", (c) => {
    const octopaiDir = c.get("octopaiDir");
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
    const octopaiDir = c.get("octopaiDir");
    const body = await c.req.json<{
      message: string;
      priority?: "critical" | "high" | "normal" | "low";
      domain?: string;
    }>();

    if (!body.message?.trim()) {
      throw HttpError.badRequest("message is required");
    }

    // Ensure mail directories exist
    const sentDir = join(octopaiDir, "mail", "sent");
    await mkdir(sentDir, { recursive: true });
    await mkdir(join(sentDir, "new"), { recursive: true });
    await mkdir(join(sentDir, "cur"), { recursive: true });
    await mkdir(join(sentDir, "tmp"), { recursive: true });

    // Write to sent maildir (brain reads from here)
    const sent = new Maildir(sentDir);
    
    // Extract subject from first line or first 100 chars
    const firstLine = body.message.split("\n")[0]?.trim() || body.message.slice(0, 100).trim();
    const subject = firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine;
    
    const mailMessage = await sent.write({
      from: "human@octopai.local",
      to: "brain@octopai.local",
      subject,
      date: new Date(),
      body: body.message,
      headers: {
        "X-Octopai-Type": "human-message",
        "X-Octopai-Priority": body.priority || "normal",
        ...(body.domain ? { "X-Octopai-Domain": body.domain } : {}),
      },
    });

    // Broadcast that a new message was sent to brain
    broadcastBrainEvent("message_received", {
      messageId: mailMessage.id,
      subject,
      priority: body.priority || "normal",
      domain: body.domain,
    });

    return c.json({ 
      sent: true, 
      messageId: mailMessage.id,
      subject,
    }, 201);
  });

  return app;
}
