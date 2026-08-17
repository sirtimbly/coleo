/**
 * Brain routes
 *
 * Brain state, control, and management endpoints.
 * 
 * NOTE: Brain state is now stored in SQLite (brain_state table), not JSON files.
 * Successful Arm claims also notify live workbench projections immediately.
 */
import { Hono, type Context } from "hono";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast, broadcastBrainEvent, broadcastMailEvent } from "../websocket";
import { getColeoDir } from "../../config";
import { join } from "path";
import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import { Maildir } from "../../mail/maildir";
import {
  getBrainState,
  updateBrainState,
  getPendingMessages,
  acquireMessageLease,
  markMessageCompleted,
  markMessageFailed,
  cleanupOldMessages,
  getDeadLetterMessages,
  requeueDeadLetterMessage,
  createNote,
  upsertTool,
  type BrainState,
} from "../../db/state";
import {
  isBrainInboxMessageType,
  validateBrainInboxPayload,
} from "../../types/brain-inbox";
import { assignTaskToArm, updateInfrastructureHealth } from "../../db/transactions";
import type { TaskAttachment } from "../../types";
import { getNatsManager } from "../../nats/server";
import { publishCommandEnvelope } from "../../nats/command-stream";
import {
  normalizeCommandEnvelope,
  validateAndRecordCommandEnvelope,
  type CommandIngressSource,
} from "../brain-command-ingress";
import {
  executeWorkspaceOperation,
  parseWorkspaceOperation,
} from "../../workspace";
import { getServerWorkspaceAccess } from "../workspace-access";
import {
	parseBrainModelAccessIssue,
	type BrainModelAccessIssueCode,
} from "../../brain/model-access";

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
  plan: {
    status: "blocked" | "healthy" | "pending";
    detail: string;
    blockedTaskCount: number;
    blockedArmCount: number;
    taskCount: number;
		nextStep: string | null;
  };
  modelAccess: {
    status: "available" | "blocked" | "unknown";
    issueCode: BrainModelAccessIssueCode | null;
    provider: string | null;
    message: string | null;
    actionLabel: string | null;
    actionUrl: string | null;
    checkedAt: string | null;
  };
}

interface CommandPublishRequestBody {
  id?: string;
  requestId?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  type?: string;
  payload?: unknown;
  createdAt?: string;
  schemaVersion?: number;
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

  app.post("/internal/workspace", async (c) => {
    const body = await c.req.json<{ operation?: unknown }>();
    let operation;
    try {
      operation = parseWorkspaceOperation(body.operation);
    } catch (error) {
      throw HttpError.badRequest(error instanceof Error ? error.message : "Invalid workspace operation");
    }

    return c.json({
      result: await executeWorkspaceOperation(getServerWorkspaceAccess(), operation),
    });
  });

  const publishCommandToJetStream = async (
    envelope: ReturnType<typeof normalizeCommandEnvelope>,
  ): Promise<void> => {
    const natsManager = getNatsManager();
    const connection = natsManager?.getConnection();
    if (!connection) {
      throw HttpError.internal("NATS connection unavailable for command publish");
    }
    try {
      await publishCommandEnvelope(connection, envelope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("max payload")) {
        throw HttpError.badRequest(message);
      }
      throw HttpError.internal(`JetStream command publish failed: ${message}`);
    }
  };

  const ingestCommand = async (
    db: Database,
    body: CommandPublishRequestBody,
    source: CommandIngressSource,
  ): Promise<{ id: string }> => {
    const envelope = normalizeCommandEnvelope(body);
    const validationError = validateAndRecordCommandEnvelope(db, envelope, source);
    if (validationError) {
      throw HttpError.badRequest(validationError);
    }

    await publishCommandToJetStream(envelope);
    return { id: envelope.id };
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
    const blockedPlanTasks = db.query(
      "SELECT COUNT(*) AS count FROM tasks WHERE status = 'blocked' AND blocked_category = 'planning'",
    ).get() as { count: number } | null;
    const latestPlanBlock = db.query(
      "SELECT blocked_reason AS reason FROM tasks WHERE status = 'blocked' AND blocked_category = 'planning' ORDER BY updated_at DESC LIMIT 1",
    ).get() as { reason: string | null } | null;
    const blockedPlanArms = db.query(
      "SELECT COUNT(*) AS count FROM arms WHERE planning_blocked = 1",
    ).get() as { count: number } | null;
    const planTasks = db.query(
      "SELECT COUNT(*) AS count FROM tasks WHERE source_type = 'plan'",
    ).get() as { count: number } | null;
		const planningGate = db.query(`
			SELECT healthy, error
			FROM infrastructure_health
			WHERE component = 'brain_planning_gate'
		`).get() as { healthy: number; error: string | null } | null;

    const blockedTaskCount = blockedPlanTasks?.count || 0;
    const blockedArmCount = blockedPlanArms?.count || 0;
    const planTaskCount = planTasks?.count || 0;
		let gateDetail = "";
		let gateNextStep: string | null = null;
		if (planningGate?.healthy === 0 && planningGate.error) {
			try {
				const parsed = JSON.parse(planningGate.error) as { detail?: unknown; nextStep?: unknown };
				gateDetail = typeof parsed.detail === "string" ? parsed.detail : planningGate.error;
				gateNextStep = typeof parsed.nextStep === "string" ? parsed.nextStep : null;
			} catch {
				gateDetail = planningGate.error;
			}
		}
    const planStatus = planningGate?.healthy === 0 || blockedTaskCount > 0 || blockedArmCount > 0
      ? "blocked"
      : planTaskCount > 0 ? "healthy" : "pending";
    const rawBlockReason = latestPlanBlock?.reason || "";
    const blockPrefix = "Project planning must succeed before work can resume: ";
    const markerIndex = rawBlockReason.lastIndexOf(" [planning-state:");
    const blockDetail = rawBlockReason.startsWith(blockPrefix)
      ? rawBlockReason.slice(blockPrefix.length, markerIndex >= 0 ? markerIndex : undefined).trim()
      : rawBlockReason.trim();
    const planDetail = planStatus === "blocked"
			? gateDetail || blockDetail || "The project planning gate is blocking task assignment."
      : planStatus === "healthy"
        ? `${planTaskCount} plan task${planTaskCount === 1 ? " is" : "s are"} synchronized with no planning blockers.`
        : "No plan tasks have been synchronized yet. Prepare a project plan or wait for the Brain's next poll.";

    const now = Date.now();
    const startedAt = brainState.startedAt ? new Date(brainState.startedAt).getTime() : null;
    const uptime = startedAt ? Math.floor((now - startedAt) / 1000) : null;
    let modelAccess: BrainStatus["modelAccess"] = {
      status: "unknown",
      issueCode: null,
      provider: null,
      message: null,
      actionLabel: null,
      actionUrl: null,
      checkedAt: null,
    };
    try {
      const row = db.query(`
        SELECT healthy, error, last_check
        FROM infrastructure_health
        WHERE component = 'brain_model_api'
      `).get() as {
        healthy: number;
        error: string | null;
        last_check: string;
      } | null;
      const issue = parseBrainModelAccessIssue(row?.error);
      if (row?.healthy === 1) {
        modelAccess = {
          ...modelAccess,
          status: "available",
          checkedAt: row.last_check,
        };
      } else if (row && issue) {
        modelAccess = {
          status: "blocked",
          issueCode: issue.code,
          provider: issue.provider,
          message: issue.message,
          actionLabel: issue.actionLabel,
          actionUrl: issue.actionUrl || null,
          checkedAt: row.last_check,
        };
      }
    } catch {
      // Older/minimal databases may not have infrastructure health yet.
    }

    const status: BrainStatus = {
      status: brainState.status,
      lastPollAt: brainState.lastPollAt || null,
      pollIntervalMs: brainState.pollIntervalMs,
      activeArmsCount: activeArmsCount?.count || 0,
      pendingTasksCount: brainState.pendingTasks,
      completedToday: brainState.completedToday,
      uptime,
      plan: {
        status: planStatus,
        detail: planDetail,
        blockedTaskCount,
        blockedArmCount,
        taskCount: planTaskCount,
			nextStep: gateNextStep,
      },
      modelAccess,
    };

    return c.json({ brain: status });
  });

  app.get("/state", (c) => {
    const db = c.get("db");
    const state = getBrainState(db);
    return c.json({ state });
  });

  app.patch("/state", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<Partial<BrainState>>();
    updateBrainState(db, body);
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

  app.get("/config/:key", (c) => {
    const db = c.get("db");
    const key = c.req.param("key");
    if (!key) {
      throw HttpError.badRequest("config key is required");
    }

    const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
    return c.json({
      key,
      value: row?.value ?? null,
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
      threadId?: string;
      subject?: string;
      attachments?: TaskAttachment[];
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
      ...(body.attachments?.length
        ? { "X-Coleo-Attachments": JSON.stringify(body.attachments) }
        : {}),
    };
    
    // Add In-Reply-To header if this is a reply
    if (body.inReplyTo) {
      headers["In-Reply-To"] = body.inReplyTo;
      // Also add References header
      headers["References"] = body.inReplyTo;
    }

    if (body.threadId || body.inReplyTo) {
      headers["X-Coleo-Thread-Id"] = body.threadId || body.inReplyTo || "";
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

  app.post("/internal/commands/publish", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<CommandPublishRequestBody>();
    const result = await ingestCommand(db, body, "api_publish");
    return c.json({ accepted: true, id: result.id });
  });

  app.post("/internal/messages/queue", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<CommandPublishRequestBody>();
    const result = await ingestCommand(db, body, "api_queue");
    return c.json({ queued: true, id: result.id });
  });

  app.get("/internal/messages/pending", (c) => {
    const db = c.get("db");
    const to = c.req.query("to") || "brain";
    const limit = Math.min(parseInt(c.req.query("limit") || "500", 10), 1000);

    const rows = getPendingMessages(db, to)
      .slice(0, limit)
      .map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        type: message.type,
        payload: message.payload,
        createdAt: message.createdAt.toISOString(),
      }));

    return c.json({ messages: rows });
  });

  app.get("/internal/messages/deadletter", (c) => {
    const db = c.get("db");
    const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
    const rows = getDeadLetterMessages(db, limit).map((message) => {
      const envelope =
        typeof message.payload === "object" &&
        message.payload !== null
          ? (message.payload as Record<string, unknown>)
          : null;
      return {
        id: message.id,
        from: message.from,
        type: message.type,
        source: typeof envelope?.source === "string" ? envelope.source : undefined,
        reason: typeof envelope?.reason === "string" ? envelope.reason : message.error,
        payload: envelope && "payload" in envelope ? envelope.payload : message.payload,
        createdAt: message.createdAt.toISOString(),
        processedAt: message.processedAt?.toISOString(),
      };
    });
    return c.json({ messages: rows });
  });

  app.post("/internal/messages/deadletter/:id/requeue", async (c) => {
    const db = c.get("db");
    const deadLetterId = c.req.param("id");
    const body = await c
      .req
      .json<{ id?: string }>()
      .catch(() => ({ id: undefined } as { id?: string }));
    if (!deadLetterId) {
      throw HttpError.badRequest("dead-letter id is required");
    }

    const row = db.query(
      `SELECT message_type, payload
       FROM messages
       WHERE id = ?
         AND to_id = 'brain.deadletter'
       LIMIT 1`,
    ).get(deadLetterId) as { message_type: string; payload: string } | null;
    if (!row) {
      throw HttpError.notFound(`Dead-letter message not found: ${deadLetterId}`);
    }

    if (!isBrainInboxMessageType(row.message_type)) {
      throw HttpError.badRequest(
        `cannot requeue unsupported brain message type: ${row.message_type}`,
      );
    }

    const parsed = JSON.parse(row.payload) as Record<string, unknown>;
    const payload = parsed && "payload" in parsed ? parsed.payload : parsed;
    const payloadError = validateBrainInboxPayload(row.message_type, payload);
    if (payloadError) {
      throw HttpError.badRequest(`cannot requeue invalid payload: ${payloadError}`);
    }

    const queuedId = body.id || `requeue-${randomUUID()}`;
    const queued = requeueDeadLetterMessage(db, deadLetterId, queuedId, "brain");
    if (!queued) {
      throw HttpError.notFound(`Dead-letter message not found: ${deadLetterId}`);
    }

    return c.json({
      queued: true,
      id: queuedId,
      sourceDeadLetterId: deadLetterId,
    });
  });

  app.post("/internal/messages/:id/status", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      status: "processing" | "completed" | "failed";
      error?: string;
    }>();

    if (!id) {
      throw HttpError.badRequest("message id is required");
    }

    if (!body.status) {
      throw HttpError.badRequest("status is required");
    }

    if (body.status === "processing") {
      const leased = acquireMessageLease(db, id);
      return c.json({ success: leased });
    } else if (body.status === "completed") {
      markMessageCompleted(db, id);
    } else if (body.status === "failed") {
      markMessageFailed(db, id, body.error || "Unknown error");
    } else {
      throw HttpError.badRequest("invalid status");
    }

    return c.json({ success: true });
  });

  app.post("/internal/messages/cleanup", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{ olderThanDays?: number }>();
    const olderThanDays = Math.max(1, body.olderThanDays ?? 7);
    const deleted = cleanupOldMessages(db, olderThanDays);
    return c.json({ deleted });
  });

  app.post("/internal/notes", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      id: string;
      author: string;
      title: string;
      content: string;
      category?: string;
      tags?: string[];
    }>();

    if (!body.id || !body.author || !body.title || !body.content) {
      throw HttpError.badRequest("id, author, title, and content are required");
    }

    createNote(db, {
      id: body.id,
      author: body.author,
      title: body.title,
      content: body.content,
      category: body.category,
      tags: body.tags || [],
    });

    return c.json({ created: true, id: body.id });
  });

  app.post("/internal/tools/upsert", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      name: string;
      command: string;
      description: string;
      discoveredBy: string;
      metadata?: Record<string, unknown>;
    }>();

    if (!body.name || !body.command || !body.description || !body.discoveredBy) {
      throw HttpError.badRequest("name, command, description, and discoveredBy are required");
    }

    upsertTool(db, {
      name: body.name,
      command: body.command,
      description: body.description,
      discoveredBy: body.discoveredBy,
      metadata: body.metadata,
    });

    return c.json({ upserted: true, name: body.name });
  });

  app.post("/internal/file-changes", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      filePath: string;
      changeType?: string;
      contentHash?: string;
      changedAt?: string;
      detectedByArmId?: string;
    }>();

    if (!body.filePath) {
      throw HttpError.badRequest("filePath is required");
    }

    db.run(
      `INSERT INTO file_changes (file_path, change_type, content_hash, changed_at, detected_by_arm_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        body.filePath,
        body.changeType || "modified",
        body.contentHash || null,
        body.changedAt || new Date().toISOString(),
        body.detectedByArmId || null,
      ],
    );

    return c.json({ recorded: true });
  });

  app.get("/internal/file-changes/count", (c) => {
    const db = c.get("db");
    const since = c.req.query("since");
    if (!since) {
      throw HttpError.badRequest("since is required");
    }

    const row = db
      .query("SELECT COUNT(*) as count FROM file_changes WHERE changed_at > ?")
      .get(since) as { count: number } | null;
    return c.json({ count: row?.count ?? 0 });
  });

  app.get("/internal/file-changes/since", (c) => {
    const db = c.get("db");
    const since = c.req.query("since");
    const limit = Math.min(parseInt(c.req.query("limit") || "1000", 10), 5000);
    if (!since) {
      throw HttpError.badRequest("since is required");
    }

    const rows = db
      .query(
        `SELECT DISTINCT file_path
         FROM file_changes
         WHERE changed_at > ?
         ORDER BY changed_at DESC
         LIMIT ?`,
      )
      .all(since, limit) as Array<{ file_path: string }>;

    return c.json({ files: rows.map((row) => row.file_path) });
  });

  app.get("/internal/doc-updates/last-completed", (c) => {
    const db = c.get("db");
    const row = db
      .query(
        `SELECT completed_at
         FROM doc_updates
         WHERE status = 'completed'
         ORDER BY completed_at DESC
         LIMIT 1`,
      )
      .get() as { completed_at: string | null } | null;
    return c.json({ completedAt: row?.completed_at || null });
  });

  app.post("/internal/doc-updates", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      id: string;
      taskId: string;
      triggerType: "phase_complete" | "threshold" | "human_request" | "periodic";
    }>();
    if (!body.id || !body.triggerType) {
      throw HttpError.badRequest("id and triggerType are required");
    }

    db.run(
      `INSERT INTO doc_updates (id, task_id, trigger_type)
       VALUES (?, ?, ?)`,
      [body.id, body.taskId || null, body.triggerType],
    );

    return c.json({ created: true, id: body.id });
  });

  app.post("/internal/doc-updates/:id/start", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!id) {
      throw HttpError.badRequest("doc update id is required");
    }

    db.run(`UPDATE doc_updates SET status = 'in_progress' WHERE id = ?`, [id]);
    return c.json({ success: true });
  });

  app.post("/internal/doc-updates/:id/complete", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      filesReviewed: number;
      docsUpdated: number;
      futureWorkNotesAdded: number;
    }>();
    if (!id) {
      throw HttpError.badRequest("doc update id is required");
    }

    db.run(
      `UPDATE doc_updates SET
         status = 'completed',
         completed_at = ?,
         files_reviewed = ?,
         docs_updated = ?,
         future_work_notes_added = ?
       WHERE id = ?`,
      [
        new Date().toISOString(),
        body.filesReviewed ?? 0,
        body.docsUpdated ?? 0,
        body.futureWorkNotesAdded ?? 0,
        id,
      ],
    );

    return c.json({ success: true });
  });

  app.post("/internal/doc-updates/:id/fail", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{ error?: string }>();
    if (!id) {
      throw HttpError.badRequest("doc update id is required");
    }

    db.run(
      `UPDATE doc_updates SET
         status = 'failed',
         completed_at = ?,
         metadata = ?
       WHERE id = ?`,
      [
        new Date().toISOString(),
        JSON.stringify({ error: body.error || "Unknown error" }),
        id,
      ],
    );

    return c.json({ success: true });
  });

  app.get("/internal/doc-updates/recent", (c) => {
    const db = c.get("db");
    const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 100);

    const rows = db
      .query(
        `SELECT id, trigger_type, status, started_at, completed_at
         FROM doc_updates
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      trigger_type: string;
      status: string;
      started_at: string;
      completed_at: string | null;
    }>;

    return c.json({
      updates: rows.map((row) => ({
        id: row.id,
        triggerType: row.trigger_type,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at || undefined,
      })),
    });
  });

  app.get("/internal/arm-state/:armId", (c) => {
    const db = c.get("db");
    const armId = c.req.param("armId");
    if (!armId) {
      throw HttpError.badRequest("armId is required");
    }

    const row = db
      .query(
        `SELECT
           arm_id,
           state,
           previous_state,
           current_task_id,
           current_task_subject,
           last_event_type,
           last_event_at,
           state_entered_at,
           task_assigned_at,
           disconnected_at,
           last_error,
           error_count,
           last_heartbeat,
           consecutive_missed_heartbeats
         FROM arm_state_machine
         WHERE arm_id = ?`,
      )
      .get(armId);

    return c.json({ state: row ?? null });
  });

  app.get("/internal/arm-state", (c) => {
    const db = c.get("db");
    const state = c.req.query("state");
    if (!state) {
      throw HttpError.badRequest("state is required");
    }

    const rows = db
      .query(
        `SELECT
           arm_id,
           state,
           previous_state,
           current_task_id,
           current_task_subject,
           last_event_type,
           last_event_at,
           state_entered_at,
           task_assigned_at,
           disconnected_at,
           last_error,
           error_count,
           last_heartbeat,
           consecutive_missed_heartbeats
         FROM arm_state_machine
         WHERE state = ?`,
      )
      .all(state);

    return c.json({ states: rows });
  });

  app.put("/internal/arm-state/:armId", async (c) => {
    const db = c.get("db");
    const armId = c.req.param("armId");
    if (!armId) {
      throw HttpError.badRequest("armId is required");
    }

    const body = await c.req.json<{
      state?: string;
      previousState?: string | null;
      currentTaskId?: string | null;
      currentTaskSubject?: string | null;
      lastEventType?: string | null;
      lastEventAt?: string;
      stateEnteredAt?: string;
      taskAssignedAt?: string | null;
      disconnectedAt?: string | null;
      lastError?: string | null;
      errorCount?: number;
      lastHeartbeat?: string | null;
      consecutiveMissedHeartbeats?: number;
    }>();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arm_state_machine (
         arm_id,
         state,
         previous_state,
         current_task_id,
         current_task_subject,
         last_event_type,
         last_event_at,
         state_entered_at,
         task_assigned_at,
         disconnected_at,
         last_error,
         error_count,
         last_heartbeat,
         consecutive_missed_heartbeats
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(arm_id) DO UPDATE SET
         state = excluded.state,
         previous_state = excluded.previous_state,
         current_task_id = excluded.current_task_id,
         current_task_subject = excluded.current_task_subject,
         last_event_type = excluded.last_event_type,
         last_event_at = excluded.last_event_at,
         state_entered_at = excluded.state_entered_at,
         task_assigned_at = excluded.task_assigned_at,
         disconnected_at = excluded.disconnected_at,
         last_error = excluded.last_error,
         error_count = excluded.error_count,
         last_heartbeat = excluded.last_heartbeat,
         consecutive_missed_heartbeats = excluded.consecutive_missed_heartbeats`,
      [
        armId,
        body.state || "spawning",
        body.previousState ?? null,
        body.currentTaskId ?? null,
        body.currentTaskSubject ?? null,
        body.lastEventType ?? null,
        body.lastEventAt || now,
        body.stateEnteredAt || now,
        body.taskAssignedAt ?? null,
        body.disconnectedAt ?? null,
        body.lastError ?? null,
        body.errorCount ?? 0,
        body.lastHeartbeat ?? null,
        body.consecutiveMissedHeartbeats ?? 0,
      ],
    );

    return c.json({ stored: true });
  });

  app.delete("/internal/arm-state/:armId", (c) => {
    const db = c.get("db");
    const armId = c.req.param("armId");
    if (!armId) {
      throw HttpError.badRequest("armId is required");
    }

    db.run("DELETE FROM arm_state_machine WHERE arm_id = ?", [armId]);
    return c.json({ deleted: true });
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

    if (result.success) {
      const task = db.query(
        "SELECT status, assigned_to AS assignedTo FROM tasks WHERE id = ?",
      ).get(body.taskId) as { status: string; assignedTo: string | null } | null;
      broadcast("tasks", "task.updated", {
        taskId: body.taskId,
        changes: {
          assignedTo: task?.assignedTo ?? body.armId,
          ...(body.isClaim === true ? { status: task?.status ?? "claimed" } : {}),
        },
      });
    }

    return c.json({ result });
  });

  app.get("/internal/infrastructure-health", (c) => {
    const db = c.get("db");

    const components = new Map<string, {
      component: string;
      healthy: boolean;
      optional: boolean;
      error?: string;
      lastCheck?: string;
    }>();

    try {
      const rows = db.query(`
        SELECT component, healthy, optional, error, last_check
        FROM infrastructure_health
      `).all() as Array<{
        component: string;
        healthy: number;
        optional: number;
        error: string | null;
        last_check: string;
      }>;

      for (const row of rows) {
        components.set(row.component, {
          component: row.component,
          healthy: row.healthy === 1,
          optional: row.optional === 1,
          error: row.error || undefined,
          lastCheck: row.last_check,
        });
      }
    } catch {
      // Table may not exist yet; we still return a live DB check below.
    }

    try {
      db.query("SELECT 1").get();
      components.set("database", {
        component: "database",
        healthy: true,
        optional: false,
        error: undefined,
        lastCheck: new Date().toISOString(),
      });
    } catch (err) {
      components.set("database", {
        component: "database",
        healthy: false,
        optional: false,
        error: err instanceof Error ? err.message : "Connection failed",
        lastCheck: new Date().toISOString(),
      });
    }

    return c.json({
      components: Array.from(components.values()),
    });
  });

  app.post("/internal/infrastructure-health", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<InfrastructureHealthRequestBody>();

    if (!Array.isArray(body.components)) {
      throw HttpError.badRequest("components must be an array");
    }

    const result = await updateInfrastructureHealth(db, body.components);
		if (body.components.some((component) =>
			component.component === "brain_model_api" || component.component === "brain_planning_gate"
		)) {
      broadcast("brain", "brain.model_access_changed", {});
    }
    return c.json({ result });
  });

  app.post("/internal/dependencies/unblock-for-completed", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{ completedTaskId: string }>();
    if (!body.completedTaskId) {
      throw HttpError.badRequest("completedTaskId is required");
    }

    const dependentRows = db.query(`
      SELECT td.task_id as taskId, t.subject
      FROM task_dependencies td
      JOIN tasks t ON td.task_id = t.id
       WHERE td.depends_on_task_id = ?
       AND t.status IN ('pending', 'blocked')
       AND (t.dependency_blocked = 1 OR t.blocked_category = 'dependency')
    `).all(body.completedTaskId) as Array<{ taskId: string; subject: string }>;

    const unblocked: Array<{ taskId: string; subject: string }> = [];
    const now = new Date().toISOString();

    for (const row of dependentRows) {
      const unmetDeps = db.query(`
        SELECT COUNT(*) as count
        FROM task_dependencies td
        WHERE td.task_id = ?
        AND td.depends_on_task_id != ?
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.id = td.depends_on_task_id
          AND t.status = 'completed'
        )
      `).get(row.taskId, body.completedTaskId) as { count: number };

      if ((unmetDeps?.count || 0) === 0) {
        db.run(
          `UPDATE tasks
           SET dependency_blocked = 0,
               status = 'pending',
               assigned_to = NULL,
               blocked_at = NULL,
               blocked_reason = NULL,
               blocked_category = NULL,
               blocked_recheck_at = NULL,
               blocked_last_checked_at = NULL,
               blocked_review_count = 0,
               blocked_needs_human = 0,
               blocked_human_notified_at = NULL,
               blocked_review_arm_id = NULL,
               blocked_review_started_at = NULL,
               updated_at = ?
           WHERE id = ?`,
          [now, row.taskId],
        );
        unblocked.push({ taskId: row.taskId, subject: row.subject });
      }
    }

    return c.json({ unblocked });
  });

  return app;
}
