/**
 * Bugs routes
 *
 * API for managing bug reports and tracking
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";

export interface Bug {
  id: string;
  title: string;
  description: string;
  source: "arm_reported" | "human_reported" | "system_detected";
  sourceArmId?: string;
  sourceTaskId?: string;
  status: "open" | "investigating" | "fixing" | "verifying" | "resolved" | "closed";
  priority: "low" | "medium" | "high" | "critical";
  assigneeArmId?: string;
  assigneeArmName?: string;
  blockers: string[]; // JSON array of blocking task IDs
  errorDetails?: string; // JSON with stack traces, logs, etc.
  resolution?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  humanNotified: boolean;
}

interface BugRow {
  id: string;
  title: string;
  description: string;
  source: string;
  source_arm_id: string | null;
  source_task_id: string | null;
  status: string;
  priority: string;
  assignee_arm_id: string | null;
  assignee_arm_name?: string;
  blockers: string | null;
  error_details: string | null;
  resolution: string | null;
  sort_order: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  human_notified: number;
}

interface BugsContext {
  Variables: {
    db: Database;
  };
}

export function createBugsRoutes() {
  const app = new Hono<BugsContext>();

  // List bugs with filtering
  app.get("/", async (c) => {
    const db = c.get("db");
    const source = c.req.query("source");
    const status = c.req.query("status");
    const priority = c.req.query("priority");
    const assignee = c.req.query("assignee");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);

    let query = `
      SELECT
        b.*,
        a.name as assignee_arm_name
      FROM bugs b
      LEFT JOIN arms a ON b.assignee_arm_id = a.id
      WHERE 1=1
    `;

    const params: (string | number)[] = [];

    if (source) {
      query += " AND b.source = ?";
      params.push(source);
    }

    if (status) {
      query += " AND b.status = ?";
      params.push(status);
    }

    if (priority) {
      query += " AND b.priority = ?";
      params.push(priority);
    }

    if (assignee) {
      query += " AND b.assignee_arm_id = ?";
      params.push(assignee);
    }

    query += " ORDER BY b.sort_order ASC, b.created_at DESC LIMIT ?";
    params.push(limit);

    try {
      const stmt = db.query(query);
      const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
      const typedRows = rows as (BugRow & { assignee_arm_name?: string })[];

      const bugs: Bug[] = typedRows.map(row => ({
        id: row.id,
        title: row.title,
        description: row.description,
        source: row.source as Bug["source"],
        sourceArmId: row.source_arm_id || undefined,
        sourceTaskId: row.source_task_id || undefined,
        status: row.status as Bug["status"],
        priority: row.priority as Bug["priority"],
        assigneeArmId: row.assignee_arm_id || undefined,
        assigneeArmName: row.assignee_arm_name || undefined,
        blockers: JSON.parse(row.blockers || "[]"),
        errorDetails: row.error_details || undefined,
        resolution: row.resolution || undefined,
        sortOrder: row.sort_order ?? undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        resolvedAt: row.resolved_at || undefined,
        humanNotified: row.human_notified === 1,
      }));

      return c.json({ bugs });
    } catch (err) {
      throw HttpError.internal("Failed to query bugs");
    }
  });

  // Get a single bug
  app.get("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db.query(`
      SELECT
        b.*,
        a.name as assignee_arm_name
      FROM bugs b
      LEFT JOIN arms a ON b.assignee_arm_id = a.id
      WHERE b.id = ?
    `).get(id) as (BugRow & { assignee_arm_name?: string }) | null;

    if (!row) {
      throw HttpError.notFound("Bug not found");
    }

    const bug: Bug = {
      id: row.id,
      title: row.title,
      description: row.description,
      source: row.source as Bug["source"],
      sourceArmId: row.source_arm_id || undefined,
      sourceTaskId: row.source_task_id || undefined,
      status: row.status as Bug["status"],
      priority: row.priority as Bug["priority"],
      assigneeArmId: row.assignee_arm_id || undefined,
      assigneeArmName: row.assignee_arm_name || undefined,
      blockers: JSON.parse(row.blockers || "[]"),
      errorDetails: row.error_details || undefined,
      resolution: row.resolution || undefined,
      sortOrder: row.sort_order ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at || undefined,
      humanNotified: row.human_notified === 1,
    };

    return c.json({ bug });
  });

  // Create a new bug
  app.post("/", async (c) => {
    const db = c.get("db");
    const body = await c.req.json();

    // Validate required fields
    if (!body.title || !body.description || !body.source) {
      throw HttpError.badRequest("Missing required fields: title, description, source");
    }

    const validSources = ["arm_reported", "human_reported", "system_detected"];
    if (!validSources.includes(body.source)) {
      throw HttpError.badRequest("Invalid source");
    }

    const validPriorities = ["low", "medium", "high", "critical"];
    const priority = body.priority || "medium";
    if (!validPriorities.includes(priority)) {
      throw HttpError.badRequest("Invalid priority");
    }

    const now = new Date().toISOString();
    const bugId = body.id || `bug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Get the current max sort_order to place new bug at the end
    const maxSortOrder = db.query("SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM bugs").get() as { max_sort: number };
    const newSortOrder = (maxSortOrder?.max_sort ?? -1) + 1;

    try {
      db.run(`
        INSERT INTO bugs (
          id, title, description, source, source_arm_id, source_task_id,
          status, priority, assignee_arm_id, blockers, error_details, metadata,
          sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        bugId,
        body.title,
        body.description,
        body.source,
        body.sourceArmId || null,
        body.sourceTaskId || null,
        priority,
        body.assigneeArmId || null,
        JSON.stringify(body.blockers || []),
        body.errorDetails || null,
        JSON.stringify(body.metadata || {}),
        newSortOrder,
        now,
        now
      ]);

      // Broadcast bug creation
      broadcast("bugs", "bug.created", { bugId, title: body.title, priority, source: body.source });

      return c.json({ bugId }, 201);
    } catch (err) {
      throw HttpError.internal("Failed to create bug");
    }
  });

  // Update a bug
  app.patch("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json();

    const validStatuses = ["open", "investigating", "fixing", "verifying", "resolved", "closed"];
    const validPriorities = ["low", "medium", "high", "critical"];

    if (body.status && !validStatuses.includes(body.status)) {
      throw HttpError.badRequest("Invalid status");
    }

    if (body.priority && !validPriorities.includes(body.priority)) {
      throw HttpError.badRequest("Invalid priority");
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.status) {
      updates.push("status = ?");
      params.push(body.status);
    }

    if (body.priority) {
      updates.push("priority = ?");
      params.push(body.priority);
    }

    if (body.assigneeArmId !== undefined) {
      updates.push("assignee_arm_id = ?");
      params.push(body.assigneeArmId);
    }

    if (body.blockers !== undefined) {
      updates.push("blockers = ?");
      params.push(JSON.stringify(body.blockers));
    }

    if (body.resolution !== undefined) {
      updates.push("resolution = ?");
      params.push(body.resolution);
      if (body.resolution && !body.resolvedAt) {
        updates.push("resolved_at = ?");
        params.push(new Date().toISOString());
      }
    }

    if (body.humanNotified !== undefined) {
      updates.push("human_notified = ?");
      params.push(body.humanNotified ? 1 : 0);
    }

    if (body.metadata !== undefined) {
      updates.push("metadata = ?");
      params.push(JSON.stringify(body.metadata));
    }

    if (body.title !== undefined) {
      updates.push("title = ?");
      params.push(body.title);
    }

    if (body.description !== undefined) {
      updates.push("description = ?");
      params.push(body.description);
    }

    if (updates.length === 0) {
      throw HttpError.badRequest("No updates provided");
    }

    updates.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);

    try {
      const result = db.run(`UPDATE bugs SET ${updates.join(", ")} WHERE id = ?`, params);

      if (result.changes === 0) {
        throw HttpError.notFound("Bug not found");
      }

      // Broadcast bug update
      broadcast("bugs", "bug.updated", { bugId: id, updates: body });

      return c.json({ success: true });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.internal("Failed to update bug");
    }
  });

  // Delete a bug
  app.delete("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    try {
      const result = db.run("DELETE FROM bugs WHERE id = ?", [id]);

      if (result.changes === 0) {
        throw HttpError.notFound("Bug not found");
      }

      // Broadcast bug deletion
      broadcast("bugs", "bug.deleted", { bugId: id });

      return c.json({ success: true });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.internal("Failed to delete bug");
    }
  });

  // Get bug statistics
  app.get("/stats", async (c) => {
    const db = c.get("db");

    try {
      const bySource = db.query(`
        SELECT source, COUNT(*) as count
        FROM bugs
        GROUP BY source
      `).all() as Array<{ source: string; count: number }>;

      const byStatus = db.query(`
        SELECT status, COUNT(*) as count
        FROM bugs
        GROUP BY status
      `).all() as Array<{ status: string; count: number }>;

      const byPriority = db.query(`
        SELECT priority, COUNT(*) as count
        FROM bugs
        GROUP BY priority
      `).all() as Array<{ priority: string; count: number }>;

      const recentCount = db.query(`
        SELECT COUNT(*) as count
        FROM bugs
        WHERE created_at > datetime('now', '-24 hours')
      `).get() as { count: number };

      const unresolvedCount = db.query(`
        SELECT COUNT(*) as count
        FROM bugs
        WHERE status NOT IN ('resolved', 'closed')
      `).get() as { count: number };

      return c.json({
        bySource: bySource.reduce((acc, s) => ({ ...acc, [s.source]: s.count }), {}),
        byStatus: byStatus.reduce((acc, s) => ({ ...acc, [s.status]: s.count }), {}),
        byPriority: byPriority.reduce((acc, p) => ({ ...acc, [p.priority]: p.count }), {}),
        recent24h: recentCount.count,
        unresolved: unresolvedCount.count,
      });
    } catch (err) {
      console.error("[BUGS STATS ERROR]", err);
      throw HttpError.internal("Failed to get bug stats");
    }
  });

  /**
   * Reorder a bug to a specific position
   * POST /api/bugs/reorder
   * Body: { bugId: string, toSortOrder: number }
   * toSortOrder: 0-based position in the full bug list (0 = top, -1 = bottom)
   */
  app.post("/reorder", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{ bugId: string; toSortOrder: number }>();
    const { bugId, toSortOrder } = body;

    // Get current bug order (sort_order ASC means lower values appear first)
    const bugs = db.query("SELECT id, sort_order FROM bugs ORDER BY sort_order ASC, created_at DESC").all() as Array<{ id: string; sort_order: number | null }>;

    // Find the bug in the list
    const bugIndex = bugs.findIndex(b => b.id === bugId);
    if (bugIndex === -1) {
      throw HttpError.notFound(`Bug not found: ${bugId}`);
    }

    // Remove bug from current position
    const movedBug = bugs.splice(bugIndex, 1)[0];
    if (!movedBug) {
      throw HttpError.notFound(`Bug not found: ${bugId}`);
    }

    // Insert at new position (handle -1 for "move to bottom")
    const finalIndex = toSortOrder < 0 ? bugs.length : Math.min(toSortOrder, bugs.length);
    bugs.splice(finalIndex, 0, movedBug);

    console.log(`[BUG REORDER] Moving bug ${bugId} from index ${bugIndex} to index ${finalIndex}, total bugs: ${bugs.length}`);

    // Update sort_order for all affected bugs
    // Index 0 (top) = sort_order 0, Index 1 = sort_order 1, etc.
    for (let i = 0; i < bugs.length; i++) {
      const sortOrder = i; // Lower sort_order = appears first
      const bugIdAtIndex = bugs[i]?.id;
      if (bugIdAtIndex) {
        console.log(`[BUG REORDER] Updating bug ${bugIdAtIndex} to sort_order ${sortOrder}`);
        db.run("UPDATE bugs SET sort_order = ? WHERE id = ?", [sortOrder, bugIdAtIndex]);
      }
    }

    // Broadcast bug updated
    const updatedBug = bugs.find(b => b.id === bugId);
    broadcast("bugs", "bug.updated", { bugId, changes: { sort_order: updatedBug?.sort_order } });

    return c.json({ success: true });
  });

  return app;
}