/**
 * Bugs routes
 *
 * API for managing bug reports and tracking
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import {
  compileResourceListFilters,
  parseResourceListFilters,
} from "./resource-list-filters";
import { assertValidResourceMetadataTags } from "./resource-metadata";

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
  archived: boolean;
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
  archived: number;
}

const ACTIVE_BUG_STATUSES = ["open", "investigating", "fixing", "verifying"] as const;
const BUG_TITLE_MIN_DUPLICATE_SCORE = 0.74;
const BUG_TITLE_SAME_TASK_MIN_DUPLICATE_SCORE = 0.66;

function parseBugRow(row: BugRow & { assignee_arm_name?: string }): Bug {
  return {
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
    archived: row.archived === 1,
  };
}

/**
 * Optional FK helper for provenance columns (source_arm_id / source_task_id /
 * assignee_arm_id). If the referenced row is missing, return null instead of
 * letting SQLite raise FOREIGN KEY constraint failed on insert.
 */
function resolveOptionalFk(
  db: Database,
  table: "arms" | "tasks",
  id: unknown,
): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;

  try {
    const row = db.query(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`).get(trimmed) as
      | { id: string }
      | null;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

function normalizeBugTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(bug-[^)]+\)/g, " ")
    .replace(/\bbug-[a-z0-9-]+\b/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeBugTitle(title: string): string[] {
  return normalizeBugTitle(title)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function buildBugTitleFtsQuery(title: string): string | null {
  const tokens = Array.from(
    new Set(
      tokenizeBugTitle(title).filter(
        (token) => token.length > 2 && token !== "bug" && token !== "issue",
      ),
    ),
  ).slice(0, 8);

  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `"${token.replace(/"/g, "\"\"")}"*`).join(" OR ");
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenizeBugTitle(left));
  const rightTokens = new Set(tokenizeBugTitle(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection++;
    }
  }

  if (intersection === 0) {
    return 0;
  }

  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isLikelyDuplicateBugTitle(left: string, right: string): boolean {
  const leftNormalized = normalizeBugTitle(left);
  const rightNormalized = normalizeBugTitle(right);
  if (leftNormalized.length === 0 || rightNormalized.length === 0) {
    return false;
  }

  if (leftNormalized === rightNormalized) {
    return true;
  }

  return titleSimilarity(leftNormalized, rightNormalized) >= 0.86;
}

function duplicateBugTitleScore(left: string, right: string): number {
  const leftNormalized = normalizeBugTitle(left);
  const rightNormalized = normalizeBugTitle(right);
  if (!leftNormalized || !rightNormalized) {
    return 0;
  }

  if (leftNormalized === rightNormalized) {
    return 1;
  }

  const similarity = titleSimilarity(leftNormalized, rightNormalized);
  if (
    leftNormalized.length >= 18 &&
    rightNormalized.length >= 18 &&
    (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized))
  ) {
    return Math.max(similarity, 0.9);
  }

  return similarity;
}

export function findSimilarActiveBug(
  db: Database,
  input: {
    title: string;
    sourceTaskId?: string;
    excludeBugId?: string;
    createdBefore?: string;
  },
): (BugRow & { assignee_arm_name?: string }) | null {
  const ftsQuery = buildBugTitleFtsQuery(input.title);
  const statusPlaceholders = ACTIVE_BUG_STATUSES.map(() => "?").join(", ");
  const excludeBugId = input.excludeBugId || null;
  const createdBefore = input.createdBefore || null;

  let candidates: Array<BugRow & { assignee_arm_name?: string }> = [];

  if (ftsQuery) {
    try {
      candidates = db.query(`
        SELECT
          b.*,
          a.name as assignee_arm_name
        FROM bugs_fts
        JOIN bugs b ON b.rowid = bugs_fts.rowid
        LEFT JOIN arms a ON b.assignee_arm_id = a.id
        WHERE bugs_fts MATCH ?
          AND b.archived = 0
          AND b.status IN (${statusPlaceholders})
          AND (? IS NULL OR b.id <> ?)
          AND (? IS NULL OR b.created_at < ? OR (b.created_at = ? AND b.id < ?))
        ORDER BY
          CASE WHEN ? IS NOT NULL AND b.source_task_id = ? THEN 0 ELSE 1 END,
          bm25(bugs_fts, 10.0),
          b.updated_at DESC
        LIMIT 25
      `).all(
        ftsQuery,
        ...ACTIVE_BUG_STATUSES,
        excludeBugId,
        excludeBugId,
        createdBefore,
        createdBefore,
        createdBefore,
        excludeBugId,
        input.sourceTaskId || null,
        input.sourceTaskId || null,
      ) as Array<BugRow & { assignee_arm_name?: string }>;
    } catch {
      // Older test fixtures or pre-migration DBs can fall back to scan mode.
    }
  }

  if (candidates.length === 0) {
    candidates = db.query(`
      SELECT
        b.*,
        a.name as assignee_arm_name
      FROM bugs b
      LEFT JOIN arms a ON b.assignee_arm_id = a.id
      WHERE b.archived = 0
        AND b.status IN (${statusPlaceholders})
        AND (? IS NULL OR b.id <> ?)
        AND (? IS NULL OR b.created_at < ? OR (b.created_at = ? AND b.id < ?))
      ORDER BY
        CASE WHEN ? IS NOT NULL AND b.source_task_id = ? THEN 0 ELSE 1 END,
        b.updated_at DESC
      LIMIT 200
    `).all(
      ...ACTIVE_BUG_STATUSES,
      excludeBugId,
      excludeBugId,
      createdBefore,
      createdBefore,
      createdBefore,
      excludeBugId,
      input.sourceTaskId || null,
      input.sourceTaskId || null,
    ) as Array<BugRow & { assignee_arm_name?: string }>;
  }

  let bestMatch: (BugRow & { assignee_arm_name?: string }) | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = duplicateBugTitleScore(candidate.title, input.title);
    const sameTask = input.sourceTaskId && candidate.source_task_id === input.sourceTaskId;
    const threshold = sameTask
      ? BUG_TITLE_SAME_TASK_MIN_DUPLICATE_SCORE
      : BUG_TITLE_MIN_DUPLICATE_SCORE;

    if (score >= threshold && score > bestScore) {
      bestMatch = candidate;
      bestScore = score;
    }
  }

  if (bestMatch) {
    return bestMatch;
  }

  return candidates.find((candidate) =>
    isLikelyDuplicateBugTitle(candidate.title, input.title),
  ) || null;
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
    const archived = c.req.query("archived");
    const search = c.req.query("search")?.trim();
    const tags = c.req.query("tags")?.split(",")
      .map((tag) => tag.trim().toLocaleLowerCase())
      .filter(Boolean) ?? [];
    const viewFilters = parseResourceListFilters(c.req.query("viewFilters"));
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 500);
    const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10));

    const baseConditions: string[] = [];
    const baseParams: (string | number)[] = [];
    if (archived === "true") {
      baseConditions.push("b.archived = 1");
    } else if (archived === "false" || archived === undefined) {
      baseConditions.push("b.archived = 0");
    }
    const baselineConditions = [...baseConditions];
    const baselineParams = [...baseParams];
    if (search) {
      const normalizedSearch = search.toLocaleLowerCase();
      baselineConditions.push(`(
        instr(lower(coalesce(b.title, '')), ?) > 0 OR
        instr(lower(coalesce(b.description, '')), ?) > 0
      )`);
      baselineParams.push(normalizedSearch, normalizedSearch);
    }
    if (source) {
      baselineConditions.push("b.source = ?");
      baselineParams.push(source);
    }
    if (status) {
      const statuses = status.split(",").map((value) => value.trim()).filter(Boolean);
      baselineConditions.push(`b.status IN (${statuses.map(() => "?").join(",")})`);
      baselineParams.push(...statuses);
    }
    if (priority) {
      baselineConditions.push("b.priority = ?");
      baselineParams.push(priority);
    }
    if (assignee) {
      baselineConditions.push("b.assignee_arm_id = ?");
      baselineParams.push(assignee);
    }
    if (tags.length > 0) {
      baselineConditions.push(`EXISTS (
        SELECT 1 FROM json_each(coalesce(json_extract(b.metadata, '$.ui.tags'), '[]'))
        WHERE lower(cast(json_each.value AS text)) IN (${tags.map(() => "?").join(",")})
      )`);
      baselineParams.push(...tags);
    }
    const conditions = [...baselineConditions];
    const params = [...baselineParams];
    const compiledViewFilters = compileResourceListFilters(viewFilters, {
      title: "b.title",
      status: "b.status",
      priority: "b.priority",
      source: "b.source",
      tags: "json_extract(b.metadata, '$.ui.tags')",
      assignee: "coalesce(a.name, b.assignee_arm_id)",
      createdAt: "b.created_at",
      updatedAt: "b.updated_at",
    });
    conditions.push(...compiledViewFilters.conditions);
    params.push(...compiledViewFilters.params);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const baselineWhereClause = baselineConditions.length > 0
      ? `WHERE ${baselineConditions.join(" AND ")}`
      : "";
    const query = `
      SELECT
        b.*,
        a.name as assignee_arm_name
      FROM bugs b
      LEFT JOIN arms a ON b.assignee_arm_id = a.id
      ${whereClause}
      ORDER BY b.sort_order ASC, b.created_at DESC
      LIMIT ? OFFSET ?
    `;

    try {
      const stmt = db.query(query);
      const rows = stmt.all(...params, limit, offset);
      const typedRows = rows as (BugRow & { assignee_arm_name?: string })[];

      const bugs: Bug[] = typedRows.map(parseBugRow);
      const filteredTotal = (db.query(`
        SELECT COUNT(*) as count
        FROM bugs b
        LEFT JOIN arms a ON b.assignee_arm_id = a.id
        ${whereClause}
      `).get(...params) as { count: number }).count;
      const searchTotal = search
        ? (db.query(`
          SELECT COUNT(*) as count
          FROM bugs b
          LEFT JOIN arms a ON b.assignee_arm_id = a.id
          ${baselineWhereClause}
        `).get(...baselineParams) as { count: number }).count
        : filteredTotal;
      return c.json({
        bugs,
        pagination: { limit, offset, total: filteredTotal },
        ...(search ? {
          searchMatches: {
            total: searchTotal,
            filtered: filteredTotal,
            hidden: Math.max(0, searchTotal - filteredTotal),
          },
        } : {}),
      });
    } catch (err) {
      throw HttpError.internal("Failed to query bugs");
    }
  });

  // Get bug statistics
  app.get("/stats", async (c) => {
    const db = c.get("db");

    try {
      const bySource = db.query(`
        SELECT source, COUNT(*) as count
        FROM bugs
        WHERE archived = 0
        GROUP BY source
      `).all() as Array<{ source: string; count: number }>;

      const byStatus = db.query(`
        SELECT status, COUNT(*) as count
        FROM bugs
        WHERE archived = 0
        GROUP BY status
      `).all() as Array<{ status: string; count: number }>;

      const byPriority = db.query(`
        SELECT priority, COUNT(*) as count
        FROM bugs
        WHERE archived = 0
        GROUP BY priority
      `).all() as Array<{ priority: string; count: number }>;

      const recentCount = db.query(`
        SELECT COUNT(*) as count
        FROM bugs
        WHERE archived = 0
          AND created_at > datetime('now', '-24 hours')
      `).get() as { count: number };

      const unresolvedCount = db.query(`
        SELECT COUNT(*) as count
        FROM bugs
        WHERE archived = 0
          AND status NOT IN ('resolved', 'closed')
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

    const bug: Bug = parseBugRow(row);

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
    assertValidResourceMetadataTags(body.metadata);

    const existingBug = findSimilarActiveBug(db, {
      title: body.title,
      sourceTaskId: body.sourceTaskId,
    });
    if (existingBug) {
      return c.json({
        bugId: existingBug.id,
        bug: parseBugRow(existingBug),
        deduplicated: true,
      });
    }

    const now = new Date().toISOString();
    const bugId = body.id || `bug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Get the current max sort_order to place new bug at the end
    const maxSortOrder = db.query("SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM bugs").get() as { max_sort: number };
    const newSortOrder = (maxSortOrder?.max_sort ?? -1) + 1;

    // Optional provenance FKs: arms report stale task/arm IDs often. Prefer nulling
    // missing refs over failing the whole insert with a cryptic 500.
    const sourceArmId = resolveOptionalFk(db, "arms", body.sourceArmId);
    const sourceTaskId = resolveOptionalFk(db, "tasks", body.sourceTaskId);
    const assigneeArmId = resolveOptionalFk(db, "arms", body.assigneeArmId);

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
        sourceArmId,
        sourceTaskId,
        priority,
        assigneeArmId,
        JSON.stringify(body.blockers || []),
        body.errorDetails || null,
        JSON.stringify(body.metadata || {}),
        newSortOrder,
        now,
        now
      ]);

      const inserted = db.query(`
        SELECT
          b.*,
          a.name as assignee_arm_name
        FROM bugs b
        LEFT JOIN arms a ON b.assignee_arm_id = a.id
        WHERE b.id = ?
      `).get(bugId) as (BugRow & { assignee_arm_name?: string }) | null;

      // Broadcast bug creation
      broadcast("bugs", "bug.created", { bugId, title: body.title, priority, source: body.source });

      return c.json({
        bugId,
        bug: inserted ? parseBugRow(inserted) : undefined,
        deduplicated: false,
      }, 201);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[bugs] Failed to create bug: ${detail}`);
      throw HttpError.internal(`Failed to create bug: ${detail}`);
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
    assertValidResourceMetadataTags(body.metadata);

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

  // Claim a bug for a specific arm
  // POST /api/bugs/:id/claim
  // Body: { armId: string }
  app.post("/:id/claim", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{ armId?: string }>();

    if (!body.armId || typeof body.armId !== "string" || !body.armId.trim()) {
      throw HttpError.badRequest("Invalid armId");
    }

    const armId = body.armId.trim();

    const bug = db
      .query("SELECT id, status, assignee_arm_id FROM bugs WHERE id = ?")
      .get(id) as { id: string; status: string; assignee_arm_id: string | null } | null;

    if (!bug) {
      throw HttpError.notFound("Bug not found");
    }

    if (!resolveOptionalFk(db, "arms", armId)) {
      throw HttpError.badRequest("Invalid armId");
    }

    const status = bug.status === "open" ? "investigating" : bug.status;

    try {
      db.run(
        "UPDATE bugs SET assignee_arm_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
        [armId, status, id],
      );

      const current = db
        .query("SELECT id, assignee_arm_id FROM bugs WHERE id = ?")
        .get(id) as { id: string; assignee_arm_id: string | null } | null;

      // Broadcast bug update
      broadcast("bugs", "bug.updated", {
        bugId: id,
        changes: { assigneeArmId: current?.assignee_arm_id },
      });

      return c.json({
        success: true,
        bug: {
          bugId: id,
          assigneeArmId: current?.assignee_arm_id || undefined,
          previousAssigneeArmId: bug.assignee_arm_id || undefined,
          status,
        },
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.internal("Failed to claim bug");
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

  /**
   * Archive a resolved bug
   * POST /api/bugs/:id/archive
   */
  app.post("/:id/archive", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if bug exists and is resolved
    const bug = db.query("SELECT id, status FROM bugs WHERE id = ?").get(id) as { id: string; status: string } | null;
    if (!bug) {
      throw HttpError.notFound("Bug not found");
    }

    // Only allow archiving resolved or closed bugs
    if (!["resolved", "closed"].includes(bug.status)) {
      throw HttpError.badRequest("Only resolved or closed bugs can be archived");
    }

    // Archive the bug
    db.run("UPDATE bugs SET archived = 1, updated_at = datetime('now') WHERE id = ?", [id]);

    // Broadcast bug updated
    broadcast("bugs", "bug.updated", { bugId: id, changes: { archived: true } });

    return c.json({ success: true, archived: true });
  });

  /**
   * Unarchive a bug
   * POST /api/bugs/:id/unarchive
   */
  app.post("/:id/unarchive", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if bug exists
    const bug = db.query("SELECT id FROM bugs WHERE id = ?").get(id) as { id: string } | null;
    if (!bug) {
      throw HttpError.notFound("Bug not found");
    }

    // Unarchive the bug
    db.run("UPDATE bugs SET archived = 0, updated_at = datetime('now') WHERE id = ?", [id]);

    // Broadcast bug updated
    broadcast("bugs", "bug.updated", { bugId: id, changes: { archived: false } });

    return c.json({ success: true, archived: false });
  });

  return app;
}
