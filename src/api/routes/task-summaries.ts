/**
 * Task Summaries routes
 *
 * API endpoints that let arms/brain record and view a running log of
 * work-in-progress summaries for a task. The most recent entry is treated
 * as the "current" summary; older entries form a timeline of progress.
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import {
  createTaskSummary,
  getTaskSummaries,
  getLatestTaskSummary,
  getTaskSummary,
  updateTaskSummary,
} from "../../db/state";
import type { TaskWorkAuthorType } from "../../types";

interface SummariesContext {
  Variables: {
    db: Database;
  };
}

interface CreateSummaryRequest {
  content: string;
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

export function createTaskSummariesRoutes() {
  const app = new Hono<SummariesContext>();

  /**
   * List all summary entries for a task (most recent first)
   * GET /api/tasks/:id/summaries
   */
  app.get("/", (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    const summaries = getTaskSummaries(db, taskId, { limit, offset });
    return c.json({ summaries, latest: summaries[0] ?? null });
  });

  /**
   * Get only the latest/current summary for a task
   * GET /api/tasks/:id/summaries/latest
   */
  app.get("/latest", (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    const summary = getLatestTaskSummary(db, taskId);
    return c.json({ summary });
  });

  /**
   * Record a new summary entry (append-only)
   * POST /api/tasks/:id/summaries
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const body = await c.req.json<CreateSummaryRequest>();

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    if (!body.content?.trim()) {
      throw HttpError.badRequest("content is required");
    }
    if (!body.authorType || !AUTHOR_TYPES.includes(body.authorType)) {
      throw HttpError.badRequest(`authorType must be one of: ${AUTHOR_TYPES.join(", ")}`);
    }
    if (!body.authorId?.trim()) {
      throw HttpError.badRequest("authorId is required");
    }

    const summaryId = `summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    createTaskSummary(db, {
      id: summaryId,
      taskId,
      content: body.content.trim(),
      authorType: body.authorType,
      authorId: body.authorId,
      authorName: body.authorName,
    });

    const summary = getTaskSummary(db, summaryId);
    if (!summary) {
      throw HttpError.internal("Failed to create summary");
    }

    broadcast("tasks", "summary.created", {
      taskId,
      summaryId,
      authorType: summary.authorType,
      authorId: summary.authorId,
    });

    return c.json({ summary }, 201);
  });

  /**
   * Edit an existing summary entry's content
   * PATCH /api/tasks/:id/summaries/:summaryId
   */
  app.patch("/:summaryId", async (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const summaryId = c.req.param("summaryId");
    const body = await c.req.json<{ content: string }>();

    if (!taskId) throw HttpError.badRequest("Task ID is required");
    requireTask(db, taskId);

    const summary = getTaskSummary(db, summaryId);
    if (!summary || summary.taskId !== taskId) {
      throw HttpError.notFound(`Summary not found: ${summaryId}`);
    }

    if (!body.content?.trim()) {
      throw HttpError.badRequest("content is required");
    }

    updateTaskSummary(db, summaryId, body.content.trim());

    const updated = getTaskSummary(db, summaryId);
    broadcast("tasks", "summary.updated", { taskId, summaryId });

    return c.json({ summary: updated });
  });

  return app;
}
