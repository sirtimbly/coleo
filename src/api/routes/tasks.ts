/**
 * Tasks routes
 * 
 * CRUD operations for brain-managed tasks
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import { withTransaction } from "../../db/transactions";
import { eventStore } from "../../nats/jetstream";

interface TasksContext {
  Variables: {
    db: Database;
  };
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "blocked" | "cancelled";
  priority: "critical" | "high" | "normal" | "low";
  sourceType: "manual" | "plan" | "email" | "discovery" | "proposal";
  sourceRef: string | null;
  phase: string | null;
  domain: string | null;
  assignedTo: string | null;
  assignedArmName?: string;
  consensusStatus?: "pending" | "in_progress" | "reached" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  dueDate: string | null;
  artifacts: string[];
  metadata: Record<string, unknown>;
}

interface TaskRow {
  id: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  source_type: string;
  source_ref: string | null;
  phase: string | null;
  domain: string | null;
  assigned_to: string | null;
  assigned_arm_name: string | null;
  consensus_status: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  claimed_at: string | null;
  started_at: string | null;
  due_date: string | null;
  artifacts: string;
  metadata: string;
}

function parseTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: row.status as Task["status"],
    priority: row.priority as Task["priority"],
    sourceType: row.source_type as Task["sourceType"],
    sourceRef: row.source_ref,
    phase: row.phase,
    domain: row.domain,
    assignedTo: row.assigned_to,
    assignedArmName: row.assigned_arm_name || undefined,
    consensusStatus: (row.consensus_status as Task["consensusStatus"]) || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    dueDate: row.due_date,
    artifacts: JSON.parse(row.artifacts || "[]"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

/**
 * Log an activity entry to JetStream
 */
function logActivity(_db: Database, actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
  if (eventStore.isInitialized()) {
    const subject = target 
      ? `octopai.events.task.${target}.${action}`
      : `octopai.events.api.${action}`;
    
    eventStore.publishEvent(subject, {
      type: action,
      armId: target,
      data: { actor, ...details },
      timestamp: new Date().toISOString(),
    }).catch(err => {
      console.error(`[tasks-api] Failed to publish activity event: ${err}`);
    });
  }
}

const CONSENSUS_ROLES = new Set(["primary", "watcher"]);
const CONSENSUS_ENTRY_STATUSES = new Set(["pending", "working", "approved", "rejected", "watching"]);
const CONSENSUS_APPROVALS = new Set(["approved", "rejected"]);

type ConsensusState = "pending" | "in_progress" | "reached" | "failed";

type ConsensusEntry = {
  armId: string;
  armName?: string;
  role: string;
  status: string;
  approval: string | null;
  approvalReason: string | null;
  lastReport: string | null;
  lastReportAt: string | null;
  updatedAt: string;
};

function fetchConsensusEntries(db: Database, taskId: string): ConsensusEntry[] {
  const rows = db.query(`
    SELECT c.arm_id, a.name as arm_name, c.role, c.status, c.approval, c.approval_reason,
           c.last_report, c.last_report_at, c.updated_at
    FROM task_arm_consensus c
    LEFT JOIN arms a ON c.arm_id = a.id
    WHERE c.task_id = ?
    ORDER BY c.updated_at DESC
  `).all(taskId) as Array<{
    arm_id: string;
    arm_name: string | null;
    role: string;
    status: string;
    approval: string | null;
    approval_reason: string | null;
    last_report: string | null;
    last_report_at: string | null;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    armId: row.arm_id,
    armName: row.arm_name || undefined,
    role: row.role,
    status: row.status,
    approval: row.approval,
    approvalReason: row.approval_reason,
    lastReport: row.last_report,
    lastReportAt: row.last_report_at,
    updatedAt: row.updated_at,
  }));
}

function determineConsensusStatus(entries: ConsensusEntry[]): ConsensusState {
  if (entries.length === 0) {
    return "pending";
  }

  if (entries.some(entry => entry.approval === "rejected" || entry.status === "rejected")) {
    return "failed";
  }

  const allApproved = entries.every(entry => entry.approval === "approved" || entry.status === "approved");
  if (allApproved) {
    return "reached";
  }

  return "in_progress";
}

export function createTasksRoutes() {
  const app = new Hono<TasksContext>();

  /**
   * List all tasks
   * GET /api/tasks
   * Query params:
   *   - status: filter by status (comma-separated for multiple)
   *   - priority: filter by priority
   *   - domain: filter by domain
   *   - assignedTo: filter by assigned arm
   *   - phase: filter by phase
   *   - limit: max results (default 100)
   *   - offset: pagination offset
   */
  app.get("/", (c) => {
    const db = c.get("db");
    
    const statusFilter = c.req.query("status");
    const priorityFilter = c.req.query("priority");
    const domainFilter = c.req.query("domain");
    const assignedToFilter = c.req.query("assignedTo");
    const phaseFilter = c.req.query("phase");
    const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (statusFilter) {
      const statuses = statusFilter.split(",").map(s => s.trim());
      conditions.push(`t.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }

    if (priorityFilter) {
      conditions.push("t.priority = ?");
      params.push(priorityFilter);
    }

    if (domainFilter) {
      conditions.push("t.domain = ?");
      params.push(domainFilter);
    }

    if (assignedToFilter) {
      conditions.push("t.assigned_to = ?");
      params.push(assignedToFilter);
    }

    if (phaseFilter) {
      conditions.push("t.phase = ?");
      params.push(phaseFilter);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get tasks with arm name via join
    const rows = db.query(`
      SELECT 
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain,
        t.assigned_to, a.name as assigned_arm_name,
        t.consensus_status,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
        t.artifacts, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      ${whereClause}
      ORDER BY 
        CASE t.status 
          WHEN 'in_progress' THEN 1
          WHEN 'claimed' THEN 2
          WHEN 'pending' THEN 3
          WHEN 'blocked' THEN 4
          WHEN 'completed' THEN 5
          WHEN 'failed' THEN 6
          WHEN 'cancelled' THEN 7
        END,
        CASE t.priority 
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
        END,
        t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as TaskRow[];

    const tasks = rows.map(parseTaskRow);

    // Get total count
    const countRow = db.query(`
      SELECT COUNT(*) as count FROM tasks t ${whereClause}
    `).get(...params) as { count: number };

    // Get counts by status
    const statusCounts = db.query(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    const counts = {
      total: countRow.count,
      byStatus: Object.fromEntries(statusCounts.map(r => [r.status, r.count])),
    };

    return c.json({
      tasks,
      pagination: {
        limit,
        offset,
        total: countRow.count,
      },
      counts,
    });
  });

  /**
   * Get a single task
   * GET /api/tasks/:id
   */
  app.get("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db.query(`
      SELECT 
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain,
        t.assigned_to, a.name as assigned_arm_name,
        t.consensus_status,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
        t.artifacts, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      WHERE t.id = ?
    `).get(id) as TaskRow | null;

    if (!row) {
      throw HttpError.notFound(`Task not found: ${id}`);
    }

    // Get dependencies
    const deps = db.query(`
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
    `).all(id) as Array<{ depends_on_task_id: string }>;

    const task = parseTaskRow(row);

    return c.json({
      task,
      dependencies: deps.map(d => d.depends_on_task_id),
    });
  });

  /**
   * Create a new task
   * POST /api/tasks
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      subject: string;
      description: string;
      priority?: Task["priority"];
      domain?: string;
      phase?: string;
      sourceType?: Task["sourceType"];
      sourceRef?: string;
      dueDate?: string;
      metadata?: Record<string, unknown>;
    }>();

    if (!body.subject?.trim()) {
      throw HttpError.badRequest("subject is required");
    }

    if (!body.description?.trim()) {
      throw HttpError.badRequest("description is required");
    }

    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    db.run(`
      INSERT INTO tasks (id, subject, description, status, priority, source_type, source_ref, phase, domain, due_date, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      body.subject.trim(),
      body.description.trim(),
      body.priority || "normal",
      body.sourceType || "manual",
      body.sourceRef || null,
      body.phase || null,
      body.domain || null,
      body.dueDate || null,
      JSON.stringify(body.metadata || {}),
      now,
      now,
    ]);

    logActivity(db, "api", "task_created", id, { subject: body.subject, priority: body.priority, domain: body.domain });

    // Broadcast task created
    broadcast("tasks", "task.created", { taskId: id, subject: body.subject });

    const row = db.query(`
      SELECT 
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain,
        t.assigned_to, NULL as assigned_arm_name,
        t.consensus_status,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
        t.artifacts, t.metadata
      FROM tasks t
      WHERE t.id = ?
    `).get(id) as TaskRow;

    return c.json({ task: parseTaskRow(row) }, 201);
  });

  /**
   * Update a task
   * PATCH /api/tasks/:id
   */
  app.patch("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      subject?: string;
      description?: string;
      status?: Task["status"];
      priority?: Task["priority"];
      domain?: string;
      phase?: string;
      assignedTo?: string | null;
      dueDate?: string | null;
      artifacts?: string[];
      metadata?: Record<string, unknown>;
    }>();

    // Check task exists
    const existing = db.query("SELECT id, status, domain FROM tasks WHERE id = ?").get(id) as { id: string; status: string; domain: string | null } | null;
    if (!existing) {
      throw HttpError.notFound(`Task not found: ${id}`);
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    const now = new Date().toISOString();

    if (body.subject !== undefined) {
      updates.push("subject = ?");
      values.push(body.subject);
    }

    if (body.description !== undefined) {
      updates.push("description = ?");
      values.push(body.description);
    }

    if (body.status !== undefined) {
      updates.push("status = ?");
      values.push(body.status);
      
      // Set timestamp fields based on status change
      if (body.status === "claimed" && existing.status === "pending") {
        updates.push("claimed_at = ?");
        values.push(now);
      } else if (body.status === "in_progress" && existing.status !== "in_progress") {
        updates.push("started_at = ?");
        values.push(now);
      } else if (body.status === "completed" || body.status === "failed" || body.status === "cancelled") {
        updates.push("completed_at = ?");
        values.push(now);
      }
    }

    if (body.priority !== undefined) {
      updates.push("priority = ?");
      values.push(body.priority);
    }

    if (body.domain !== undefined) {
      updates.push("domain = ?");
      values.push(body.domain);
    }

    if (body.phase !== undefined) {
      updates.push("phase = ?");
      values.push(body.phase);
    }

    if (body.assignedTo !== undefined) {
      updates.push("assigned_to = ?");
      values.push(body.assignedTo);
    }

    if (body.dueDate !== undefined) {
      updates.push("due_date = ?");
      values.push(body.dueDate);
    }

    if (body.artifacts !== undefined) {
      updates.push("artifacts = ?");
      values.push(JSON.stringify(body.artifacts));
    }

    if (body.metadata !== undefined) {
      updates.push("metadata = ?");
      values.push(JSON.stringify(body.metadata));
    }

    if (updates.length === 0) {
      throw HttpError.badRequest("No fields to update");
    }

    updates.push("updated_at = ?");
    values.push(now);
    values.push(id);

    db.run(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`, values as (string | number | null)[]);

    logActivity(db, "api", "task_updated", id, body);

    // Broadcast task updated
    broadcast("tasks", "task.updated", { taskId: id, changes: body });

    // Fetch updated task
    const row = db.query(`
      SELECT 
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain,
        t.assigned_to, a.name as assigned_arm_name,
        t.consensus_status,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
        t.artifacts, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      WHERE t.id = ?
    `).get(id) as TaskRow;

    return c.json({ task: parseTaskRow(row) });
  });

  app.get("/:id/consensus", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const task = db.query("SELECT consensus_status FROM tasks WHERE id = ?").get(id) as { consensus_status: string | null } | null;
    if (!task) {
      throw HttpError.notFound(`Task not found: ${id}`);
    }

    const entries = fetchConsensusEntries(db, id);
    const consensusStatus = determineConsensusStatus(entries);

    return c.json({
      taskId: id,
      consensusStatus,
      entries,
    });
  });

  app.post("/:id/consensus", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      armId: string;
      role?: "primary" | "watcher";
      status: "pending" | "working" | "approved" | "rejected" | "watching";
      approval?: "approved" | "rejected";
      approvalReason?: string | null;
      report?: string | null;
    }>();

    const task = db.query("SELECT consensus_status FROM tasks WHERE id = ?").get(id) as { consensus_status: string | null } | null;
    if (!task) {
      throw HttpError.notFound(`Task not found: ${id}`);
    }

    const armId = body.armId?.trim();
    if (!armId) {
      throw HttpError.badRequest("armId is required");
    }

    if (!body.status || !CONSENSUS_ENTRY_STATUSES.has(body.status)) {
      throw HttpError.badRequest("status is required and must be a valid consensus status");
    }

    if (body.role && !CONSENSUS_ROLES.has(body.role)) {
      throw HttpError.badRequest("role must be 'primary' or 'watcher'");
    }

    if (body.approval && !CONSENSUS_APPROVALS.has(body.approval)) {
      throw HttpError.badRequest("approval must be 'approved' or 'rejected'");
    }

    const arm = db.query("SELECT id FROM arms WHERE id = ?").get(armId) as { id: string } | null;
    if (!arm) {
      throw HttpError.badRequest(`Arm not found: ${armId}`);
    }

    const now = new Date().toISOString();

    // Wrap consensus update in transaction for atomicity
    const result = await withTransaction(db, async (db) => {
      const existing = db.query("SELECT id, role FROM task_arm_consensus WHERE task_id = ? AND arm_id = ?").get(id, armId) as { id: number; role: string } | null;
      const role = body.role || existing?.role || "watcher";
      const approval = body.approval || null;
      const approvalReason = body.approvalReason?.trim() || null;
      const hasReportField = Object.prototype.hasOwnProperty.call(body, "report");
      const reportValue = body.report ?? null;
      const reportTimestamp = reportValue ? now : null;

      if (existing) {
        const updates = ["role = ?", "status = ?", "approval = ?", "approval_reason = ?", "updated_at = ?"];
        const params: (string | number | null)[] = [role, body.status, approval, approvalReason, now];

        if (hasReportField) {
          updates.push("last_report = ?");
          updates.push("last_report_at = ?");
          params.push(reportValue, reportTimestamp);
        }

        params.push(existing.id);
        db.run(`UPDATE task_arm_consensus SET ${updates.join(", ")} WHERE id = ?`, params);
      } else {
        db.run(
          `INSERT INTO task_arm_consensus (task_id, arm_id, role, status, approval, approval_reason, last_report, last_report_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            armId,
            role,
            body.status,
            approval,
            approvalReason,
            reportValue,
            reportTimestamp,
            now,
            now,
          ]
        );
      }

      const entries = fetchConsensusEntries(db, id);
      const consensusStatus = determineConsensusStatus(entries);
      const currentStatus = task.consensus_status || "pending";

      if (consensusStatus !== currentStatus) {
        db.run(`UPDATE tasks SET consensus_status = ?, updated_at = ? WHERE id = ?`, [consensusStatus, now, id]);
      }

      logActivity(db, `arm:${armId}`, "task_consensus_update", id, {
        role,
        status: body.status,
        approval,
      });

      return { consensusStatus, entries };
    });

    if (!result.success) {
      throw HttpError.internal(`Failed to update consensus: ${result.error}`);
    }

    const { consensusStatus, entries } = result.data!;
    broadcast("tasks", "task.consensus", { taskId: id, consensusStatus });

    return c.json({
      taskId: id,
      consensusStatus,
      entries,
    });
  });

  /**
   * Delete a task
   * DELETE /api/tasks/:id
   */
  app.delete("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const result = db.run("DELETE FROM tasks WHERE id = ?", [id]);
    if (result.changes === 0) {
      throw HttpError.notFound(`Task not found: ${id}`);
    }

    logActivity(db, "api", "task_deleted", id);

    // Broadcast task deleted
    broadcast("tasks", "task.deleted", { taskId: id });

    return c.json({ deleted: true });
  });

  return app;
}
