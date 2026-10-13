/**
 * Task Diffs routes
 *
 * API endpoints that let arms/brain record and view unified diffs as work
 * progresses on a task, plus lightweight per-user "viewed" tracking so the
 * UI can badge unseen diffs (mirrors the task discussions read-receipt
 * pattern).
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import {
  createTaskDiff,
  getTaskDiffs,
  getTaskDiff,
  getTaskDiffCount,
  markTaskDiffsViewed,
  getUnviewedDiffCount,
} from "../../db/state";
import type { TaskWorkAuthorType } from "../../types";

interface DiffsContext {
  Variables: {
    db: Database;
  };
}

interface CreateDiffRequest {
  title?: string;
  filePath?: string;
  diff: string;
  additions?: number;
  deletions?: number;
  authorType: TaskWorkAuthorType;
  authorId: string;
  authorName?: string;
}

const AUTHOR_TYPES: TaskWorkAuthorType[] = ["arm", "brain", "human"];

function requireTask(db: Database, taskId: string): void {
  const exists = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
  if (!exists) {
    throw HttpError.notFound(`Task not found: ${taskId}`);
  }
}

/**
 * Best-effort +/- line counts from a unified diff body, used when the
 * caller doesn't supply explicit additions/deletions.
 */
function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function createTaskDiffsRoutes() {
  const app = new Hono<DiffsContext>();

  /**
   * List all diff entries for a task (most recent first)
   * GET /api/tasks/:id/diffs
   */
  app.get("/", (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    const diffs = getTaskDiffs(db, taskId, { limit, offset });
    return c.json({ diffs, totalCount: getTaskDiffCount(db, taskId) });
  });

  /**
   * Get unviewed diff count for a user (check before /:diffId so it doesn't
   * get swallowed by the param route)
   * GET /api/tasks/:id/diffs/unviewed
   */
  app.get("/unviewed", (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const userId = c.req.query("userId");

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    if (!userId?.trim()) {
      throw HttpError.badRequest("userId query parameter is required");
    }

    return c.json({ unviewedCount: getUnviewedDiffCount(db, taskId, userId) });
  });

  /**
   * Mark diffs as viewed for a user
   * POST /api/tasks/:id/diffs/mark-viewed
   */
  app.post("/mark-viewed", async (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const body = await c.req.json<{ userId: string; lastViewedDiffId: string }>();

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    if (!body.userId?.trim()) {
      throw HttpError.badRequest("userId is required");
    }
    if (!body.lastViewedDiffId?.trim()) {
      throw HttpError.badRequest("lastViewedDiffId is required");
    }

    const diffExists = getTaskDiff(db, body.lastViewedDiffId);
    if (!diffExists || diffExists.taskId !== taskId) {
      throw HttpError.badRequest(`Diff not found: ${body.lastViewedDiffId}`);
    }

    markTaskDiffsViewed(db, taskId, body.userId, body.lastViewedDiffId);

    return c.json({ marked: true });
  });

  /**
   * Get a single diff's full content
   * GET /api/tasks/:id/diffs/:diffId
   */
  app.get("/:diffId", (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const diffId = c.req.param("diffId");

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    const diff = getTaskDiff(db, diffId);
    if (!diff || diff.taskId !== taskId) {
      throw HttpError.notFound(`Diff not found: ${diffId}`);
    }

    return c.json({ diff });
  });

  /**
   * Record a new diff entry
   * POST /api/tasks/:id/diffs
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const body = await c.req.json<CreateDiffRequest>();

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    if (!body.diff?.trim()) {
      throw HttpError.badRequest("diff is required");
    }
    if (!body.authorType || !AUTHOR_TYPES.includes(body.authorType)) {
      throw HttpError.badRequest(`authorType must be one of: ${AUTHOR_TYPES.join(", ")}`);
    }
    if (!body.authorId?.trim()) {
      throw HttpError.badRequest("authorId is required");
    }

    const diffId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const stats =
      body.additions !== undefined && body.deletions !== undefined
        ? { additions: body.additions, deletions: body.deletions }
        : countDiffStats(body.diff);

    createTaskDiff(db, {
      id: diffId,
      taskId,
      title: body.title,
      filePath: body.filePath,
      diff: body.diff,
      additions: stats.additions,
      deletions: stats.deletions,
      authorType: body.authorType,
      authorId: body.authorId,
      authorName: body.authorName,
    });

    const diff = getTaskDiff(db, diffId);
    if (!diff) {
      throw HttpError.internal("Failed to create diff");
    }

    broadcast("tasks", "diff.created", {
      taskId,
      diffId,
      authorType: diff.authorType,
      authorId: diff.authorId,
      additions: diff.additions,
      deletions: diff.deletions,
    });

    return c.json({ diff }, 201);
  });

  return app;
}
