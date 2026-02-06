/**
 * Task Discussions routes
 *
 * API endpoints for task comments and discussions
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import {
  createTaskComment,
  getTaskComment,
  updateTaskComment,
  deleteTaskComment,
  updateTaskCommentStats,
  markTaskCommentsRead,
  getUnreadCommentCount,
} from "../../db/state";

interface DiscussionsContext {
  Variables: {
    db: Database;
  };
}

interface CreateDiscussionRequest {
  content: string;
  parentId?: string;
  authorType: "human" | "arm" | "brain";
  authorId: string;
  authorName?: string;
  screenshotPath?: string;
  client: "web" | "mail" | "mcp" | "cli";
}

interface TaskCommentResponse {
  id: string;
  taskId: string;
  parentId?: string;
  content: string;
  authorType: "human" | "arm" | "brain";
  authorId: string;
  authorName?: string;
  screenshotPath?: string;
  client: "web" | "mail" | "mcp" | "cli";
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ThreadedComment extends TaskCommentResponse {
  replies: ThreadedComment[];
}

function toCommentResponse(row: {
  id: string;
  task_id: string;
  parent_id: string | null;
  content: string;
  screenshot_path?: string | null;
  author_type: "human" | "arm" | "brain";
  author_id: string;
  author_name: string | null;
  client: "web" | "mail" | "mcp" | "cli";
  edited: number;
  deleted: number;
  created_at: string;
  updated_at: string;
}): TaskCommentResponse {
  return {
    id: row.id,
    taskId: row.task_id,
    parentId: row.parent_id || undefined,
    content: row.content,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name || undefined,
  screenshotPath: row.screenshot_path || undefined,
  client: row.client,
    edited: row.edited === 1,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildThreadedComments(
  comments: TaskCommentResponse[],
  parentId: string | null = null
): ThreadedComment[] {
  const result: ThreadedComment[] = [];

  for (const comment of comments) {
    if ((comment.parentId || null) === parentId) {
      const threaded: ThreadedComment = {
        ...comment,
        replies: buildThreadedComments(comments, comment.id),
      };
      result.push(threaded);
    }
  }

  return result;
}

export function createTaskDiscussionsRoutes() {
  const app = new Hono<DiscussionsContext>();

  /**
   * List all discussions for a task
   * GET /api/tasks/:id/discussions
   */
  app.get("/", (c) => {
    const db = c.get("db");
    const taskIdParam = c.req.param("id");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);
    const threaded = c.req.query("threaded") === "true";

    if (!taskIdParam) {
      throw HttpError.badRequest("Task ID is required");
    }

    const taskId = taskIdParam;

    // Check task exists
    const taskExists = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
    if (!taskExists) {
      throw HttpError.notFound(`Task not found: ${taskId}`);
    }

    // Get total count
    const countRow = db
      .query("SELECT COUNT(*) as count FROM task_comments WHERE task_id = ? AND deleted = 0")
      .get(taskId) as { count: number };

    // Get comments
    const rows = db
      .query(
        `SELECT * FROM task_comments
         WHERE task_id = ? AND deleted = 0
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(taskId, limit, offset) as Array<{
      id: string;
      task_id: string;
      parent_id: string | null;
      content: string;
      author_type: "human" | "arm" | "brain";
      author_id: string;
      author_name: string | null;
      client: "web" | "mail" | "mcp" | "cli";
      edited: number;
      deleted: number;
      created_at: string;
      updated_at: string;
    }>;

    const comments = rows.map(toCommentResponse);

    if (threaded) {
      const threadedComments = buildThreadedComments(comments);
      return c.json({
        discussions: threadedComments,
        totalCount: countRow.count,
      });
    }

    return c.json({
      discussions: comments,
      totalCount: countRow.count,
    });
  });

  /**
   * Add a new comment to a task
   * POST /api/tasks/:id/discussions
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const taskIdParam = c.req.param("id");
    const body = await c.req.json<CreateDiscussionRequest>();

    if (!taskIdParam) {
      throw HttpError.badRequest("Task ID is required");
    }

    const taskId = taskIdParam;

    // Check task exists
    const taskExists = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
    if (!taskExists) {
      throw HttpError.notFound(`Task not found: ${taskId}`);
    }

    // Validate required fields
    if (!body.content?.trim()) {
      throw HttpError.badRequest("Content is required");
    }

    if (!body.authorType || !["human", "arm", "brain"].includes(body.authorType)) {
      throw HttpError.badRequest("authorType must be one of: human, arm, brain");
    }

    if (!body.authorId?.trim()) {
      throw HttpError.badRequest("authorId is required");
    }

    if (!body.client || !["web", "mail", "mcp", "cli"].includes(body.client)) {
      throw HttpError.badRequest("client must be one of: web, mail, mcp, cli");
    }

    // Validate parentId if provided
    if (body.parentId) {
      const parentExists = db
        .query("SELECT id, task_id FROM task_comments WHERE id = ? AND deleted = 0")
        .get(body.parentId) as { id: string; task_id: string } | null;

      if (!parentExists) {
        throw HttpError.badRequest(`Parent comment not found: ${body.parentId}`);
      }

      if (parentExists.task_id !== taskId) {
        throw HttpError.badRequest("Parent comment does not belong to this task");
      }
    }

    const commentId = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    createTaskComment(db, {
      id: commentId,
      taskId,
      parentId: body.parentId,
      content: body.content.trim(),
      authorType: body.authorType,
      authorId: body.authorId,
      authorName: body.authorName,
      client: body.client,
      screenshotPath: body.screenshotPath,
    });

    // Update task stats
    updateTaskCommentStats(db, taskId);

    // Get the created comment
    const comment = getTaskComment(db, commentId);
    if (!comment) {
      throw HttpError.internal("Failed to create comment");
    }

    // Broadcast event
    broadcast("tasks", "discussion.created", {
      taskId,
      commentId,
      authorType: comment.authorType,
      authorId: comment.authorId,
    });

    return c.json({ comment }, 201);
  });

  /**
   * Edit a comment
   * PATCH /api/tasks/:id/discussions/:commentId
   */
  app.patch("/:commentId", async (c) => {
    const db = c.get("db");
    const taskIdParam = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await c.req.json<{ content: string; authorId: string }>();

    if (!taskIdParam) {
      throw HttpError.badRequest("Task ID is required");
    }

    if (!commentId) {
      throw HttpError.badRequest("Comment ID is required");
    }

    const taskId = taskIdParam;

    // Check task exists
    const taskExists = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
    if (!taskExists) {
      throw HttpError.notFound(`Task not found: ${taskId}`);
    }

    // Get comment
    const comment = getTaskComment(db, commentId);
    if (!comment) {
      throw HttpError.notFound(`Comment not found: ${commentId}`);
    }

    if (comment.taskId !== taskId) {
      throw HttpError.notFound(`Comment not found: ${commentId}`);
    }

    if (comment.deleted) {
      throw HttpError.badRequest("Cannot edit deleted comment");
    }

    // Check authorization (only original author can edit)
    if (body.authorId !== comment.authorId) {
      throw HttpError.forbidden("Only the original author can edit this comment");
    }

    // Check 24-hour edit window
    const createdAt = new Date(comment.createdAt);
    const now = new Date();
    const hoursSinceCreation = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceCreation > 24) {
      throw HttpError.forbidden("Comments can only be edited within 24 hours of creation");
    }

    // Validate content
    if (!body.content?.trim()) {
      throw HttpError.badRequest("Content is required");
    }

    updateTaskComment(db, commentId, { content: body.content.trim() });

    // Get updated comment
    const updatedComment = getTaskComment(db, commentId);
    if (!updatedComment) {
      throw HttpError.internal("Failed to update comment");
    }

    // Broadcast event
    broadcast("tasks", "discussion.updated", {
      taskId,
      commentId,
      authorType: updatedComment.authorType,
    });

    return c.json({ comment: updatedComment });
  });

  /**
   * Soft delete a comment
   * DELETE /api/tasks/:id/discussions/:commentId
   */
  app.delete("/:commentId", async (c) => {
    const db = c.get("db");
    const taskIdParam = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await c.req.json<{ authorId: string }>();

    if (!taskIdParam) {
      throw HttpError.badRequest("Task ID is required");
    }

    if (!commentId) {
      throw HttpError.badRequest("Comment ID is required");
    }

    const taskId = taskIdParam;

    // Check task exists
    const taskExists = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
    if (!taskExists) {
      throw HttpError.notFound(`Task not found: ${taskId}`);
    }

    // Get comment
    const comment = getTaskComment(db, commentId);
    if (!comment) {
      throw HttpError.notFound(`Comment not found: ${commentId}`);
    }

    if (comment.taskId !== taskId) {
      throw HttpError.notFound(`Comment not found: ${commentId}`);
    }

    if (comment.deleted) {
      throw HttpError.badRequest("Comment is already deleted");
    }

    // Check authorization (only original author can delete)
    if (body.authorId !== comment.authorId) {
      throw HttpError.forbidden("Only the original author can delete this comment");
    }

    deleteTaskComment(db, commentId);

    // Update task stats
    updateTaskCommentStats(db, taskId);

    // Broadcast event
    broadcast("tasks", "discussion.deleted", {
      taskId,
      commentId,
      authorType: comment.authorType,
    });

    return c.json({ deleted: true });
  });

  /**
   * Mark discussions as read for a user
   * POST /api/tasks/:id/discussions/mark-read
   */
  app.post("/mark-read", async (c) => {
    const db = c.get("db");
    const taskIdParam = c.req.param("id");
    const body = await c.req.json<{ userId: string; lastReadCommentId: string }>();

    if (!taskIdParam) {
      throw HttpError.badRequest("Task ID is required");
    }

    const taskId = taskIdParam;

    // Check task exists
    const taskExists = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
    if (!taskExists) {
      throw HttpError.notFound(`Task not found: ${taskId}`);
    }

    if (!body.userId?.trim()) {
      throw HttpError.badRequest("userId is required");
    }

    if (!body.lastReadCommentId?.trim()) {
      throw HttpError.badRequest("lastReadCommentId is required");
    }

    // Verify the comment exists
    const commentExists = db
      .query("SELECT id FROM task_comments WHERE id = ? AND task_id = ?")
      .get(body.lastReadCommentId, taskId) as { id: string } | null;

    if (!commentExists) {
      throw HttpError.badRequest(`Comment not found: ${body.lastReadCommentId}`);
    }

    markTaskCommentsRead(db, taskId, body.userId, body.lastReadCommentId);

    return c.json({ marked: true });
  });

  /**
   * Get unread count for current user
   * GET /api/tasks/:id/discussions/unread
   */
  app.get("/unread", (c) => {
    const db = c.get("db");
    const taskIdParam = c.req.param("id");
    const userId = c.req.query("userId");

    if (!taskIdParam) {
      throw HttpError.badRequest("Task ID is required");
    }

    const taskId = taskIdParam;

    // Check task exists
    const taskExists = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
    if (!taskExists) {
      throw HttpError.notFound(`Task not found: ${taskId}`);
    }

    if (!userId?.trim()) {
      throw HttpError.badRequest("userId query parameter is required");
    }

    const unreadCount = getUnreadCommentCount(db, taskId, userId);

    return c.json({ unreadCount });
  });

  return app;
}
