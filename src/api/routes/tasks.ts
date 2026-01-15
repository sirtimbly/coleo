/**
 * Tasks routes
 * 
 * CRUD operations for brain-managed tasks
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";

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
 * Log an activity entry
 */
function logActivity(db: Database, actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO activity (timestamp, actor, action, target, details) VALUES (?, ?, ?, ?, ?)`,
    [now, actor, action, target || null, JSON.stringify(details || {})]
  );
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
    const existing = db.query("SELECT id, status FROM tasks WHERE id = ?").get(id) as { id: string; status: string } | null;
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
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
        t.artifacts, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      WHERE t.id = ?
    `).get(id) as TaskRow;

    return c.json({ task: parseTaskRow(row) });
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
