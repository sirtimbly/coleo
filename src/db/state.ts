/**
 * Database state utilities
 * 
 * Provides typed access to brain_state, messages, tools, and notes tables.
 * These replace JSON file storage for single source of truth.
 */

import type { Database } from "bun:sqlite";

// ============================================
// Brain State
// ============================================

export interface BrainStateRow {
  id: number;
  status: "stopped" | "running" | "paused";
  poll_interval_ms: number;
  started_at: string | null;
  last_poll_at: string | null;
  pending_tasks: number;
  completed_today: number;
  updated_at: string;
}

export interface BrainState {
  status: "stopped" | "running" | "paused";
  pollIntervalMs: number;
  startedAt?: string;
  lastPollAt?: string;
  pendingTasks: number;
  completedToday: number;
}

/**
 * Get the current brain state from SQLite
 */
export function getBrainState(db: Database): BrainState {
  const row = db.query("SELECT * FROM brain_state WHERE id = 1").get() as BrainStateRow | null;
  
  if (!row) {
    // Initialize if not exists
    db.run("INSERT OR IGNORE INTO brain_state (id, status, poll_interval_ms) VALUES (1, 'stopped', 30000)");
    return {
      status: "stopped",
      pollIntervalMs: 30000,
      pendingTasks: 0,
      completedToday: 0,
    };
  }
  
  return {
    status: row.status,
    pollIntervalMs: row.poll_interval_ms,
    startedAt: row.started_at || undefined,
    lastPollAt: row.last_poll_at || undefined,
    pendingTasks: row.pending_tasks,
    completedToday: row.completed_today,
  };
}

/**
 * Update brain state in SQLite
 */
export function updateBrainState(db: Database, updates: Partial<BrainState>): void {
  const now = new Date().toISOString();
  const setClauses: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [now];
  
  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.pollIntervalMs !== undefined) {
    setClauses.push("poll_interval_ms = ?");
    values.push(updates.pollIntervalMs);
  }
  if (updates.startedAt !== undefined) {
    setClauses.push("started_at = ?");
    values.push(updates.startedAt);
  }
  if (updates.lastPollAt !== undefined) {
    setClauses.push("last_poll_at = ?");
    values.push(updates.lastPollAt);
  }
  if (updates.pendingTasks !== undefined) {
    setClauses.push("pending_tasks = ?");
    values.push(updates.pendingTasks);
  }
  if (updates.completedToday !== undefined) {
    setClauses.push("completed_today = ?");
    values.push(updates.completedToday);
  }
  
  values.push(1); // id = 1
  db.run(`UPDATE brain_state SET ${setClauses.join(", ")} WHERE id = ?`, values);
}

// ============================================
// Messages (Queue)
// ============================================

export interface MessageRow {
  id: string;
  from_id: string;
  to_id: string;
  message_type: string;
  payload: string;
  status: "pending" | "processing" | "completed" | "failed";
  created_at: string;
  processed_at: string | null;
  error: string | null;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: Date;
  processedAt?: Date;
  error?: string;
}

/**
 * Queue a message for delivery
 */
export function queueMessage(
  db: Database,
  message: {
    id: string;
    from: string;
    to: string;
    type: string;
    payload: unknown;
  }
): void {
  db.run(
    `INSERT INTO messages (id, from_id, to_id, message_type, payload, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [
      message.id,
      message.from,
      message.to,
      message.type,
      JSON.stringify(message.payload),
      new Date().toISOString(),
    ]
  );
}

/**
 * Get pending messages for a recipient
 */
export function getPendingMessages(db: Database, toId: string): Message[] {
  const rows = db.query(
    `SELECT * FROM messages WHERE to_id = ? AND status = 'pending' ORDER BY created_at ASC`
  ).all(toId) as MessageRow[];
  
  return rows.map(rowToMessage);
}

/**
 * Get all pending messages for brain
 */
export function getPendingBrainMessages(db: Database): Message[] {
  return getPendingMessages(db, "brain");
}

/**
 * Mark a message as processing
 */
export function markMessageProcessing(db: Database, id: string): void {
  db.run("UPDATE messages SET status = 'processing' WHERE id = ?", [id]);
}

/**
 * Mark a message as completed
 */
export function markMessageCompleted(db: Database, id: string): void {
  db.run(
    "UPDATE messages SET status = 'completed', processed_at = ? WHERE id = ?",
    [new Date().toISOString(), id]
  );
}

/**
 * Mark a message as failed
 */
export function markMessageFailed(db: Database, id: string, error: string): void {
  db.run(
    "UPDATE messages SET status = 'failed', processed_at = ?, error = ? WHERE id = ?",
    [new Date().toISOString(), error, id]
  );
}

/**
 * Clean up old completed/failed messages (retention policy)
 */
export function cleanupOldMessages(db: Database, olderThanDays: number = 7): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.run(
    "DELETE FROM messages WHERE status IN ('completed', 'failed') AND created_at < ?",
    [cutoff]
  );
  return result.changes;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    type: row.message_type,
    payload: JSON.parse(row.payload),
    status: row.status,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
    error: row.error || undefined,
  };
}

// ============================================
// Tools (Toolbox)
// ============================================

export interface ToolRow {
  name: string;
  command: string;
  description: string;
  discovered_by: string;
  discovered_at: string;
  metadata: string;
}

export interface Tool {
  name: string;
  command: string;
  description: string;
  discoveredBy: string;
  discoveredAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Add or update a discovered tool
 */
export function upsertTool(
  db: Database,
  tool: {
    name: string;
    command: string;
    description: string;
    discoveredBy: string;
    metadata?: Record<string, unknown>;
  }
): void {
  db.run(
    `INSERT INTO tools (name, command, description, discovered_by, discovered_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       command = excluded.command,
       description = excluded.description,
       metadata = excluded.metadata`,
    [
      tool.name,
      tool.command,
      tool.description,
      tool.discoveredBy,
      new Date().toISOString(),
      JSON.stringify(tool.metadata || {}),
    ]
  );
}

/**
 * Get all discovered tools
 */
export function getAllTools(db: Database): Tool[] {
  const rows = db.query("SELECT * FROM tools ORDER BY discovered_at DESC").all() as ToolRow[];
  return rows.map(rowToTool);
}

/**
 * Get a tool by name
 */
export function getTool(db: Database, name: string): Tool | null {
  const row = db.query("SELECT * FROM tools WHERE name = ?").get(name) as ToolRow | null;
  return row ? rowToTool(row) : null;
}

function rowToTool(row: ToolRow): Tool {
  return {
    name: row.name,
    command: row.command,
    description: row.description,
    discoveredBy: row.discovered_by,
    discoveredAt: new Date(row.discovered_at),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

// ============================================
// Notes (Shared Notes)
// ============================================

export interface NoteRow {
  id: string;
  author: string;
  title: string;
  content: string;
  category: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  author: string;
  title: string;
  content: string;
  category?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create a new note
 */
export function createNote(
  db: Database,
  note: {
    id: string;
    author: string;
    title: string;
    content: string;
    category?: string;
    tags?: string[];
  }
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO notes (id, author, title, content, category, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      note.id,
      note.author,
      note.title,
      note.content,
      note.category || null,
      JSON.stringify(note.tags || []),
      now,
      now,
    ]
  );
}

/**
 * Get all notes, optionally filtered by author or category
 */
export function getNotes(
  db: Database,
  options?: { author?: string; category?: string; limit?: number }
): Note[] {
  let query = "SELECT * FROM notes WHERE 1=1";
  const params: (string | number)[] = [];
  
  if (options?.author) {
    query += " AND author = ?";
    params.push(options.author);
  }
  if (options?.category) {
    query += " AND category = ?";
    params.push(options.category);
  }
  
  query += " ORDER BY created_at DESC";
  
  if (options?.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }
  
  const rows = db.query(query).all(...params) as NoteRow[];
  return rows.map(rowToNote);
}

/**
 * Search notes by content
 */
export function searchNotes(db: Database, query: string, limit: number = 10): Note[] {
  const rows = db.query(
    `SELECT notes.* FROM notes
     JOIN notes_fts ON notes.rowid = notes_fts.rowid
     WHERE notes_fts MATCH ?
     ORDER BY rank
     LIMIT ?`
  ).all(query, limit) as NoteRow[];
  return rows.map(rowToNote);
}

/**
 * Get a note by ID
 */
export function getNote(db: Database, id: string): Note | null {
  const row = db.query("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | null;
  return row ? rowToNote(row) : null;
}

/**
 * Update a note
 */
export function updateNote(
  db: Database,
  id: string,
  updates: { title?: string; content?: string; category?: string; tags?: string[] }
): void {
  const setClauses: string[] = ["updated_at = ?"];
  const values: (string | null)[] = [new Date().toISOString()];
  
  if (updates.title !== undefined) {
    setClauses.push("title = ?");
    values.push(updates.title);
  }
  if (updates.content !== undefined) {
    setClauses.push("content = ?");
    values.push(updates.content);
  }
  if (updates.category !== undefined) {
    setClauses.push("category = ?");
    values.push(updates.category);
  }
  if (updates.tags !== undefined) {
    setClauses.push("tags = ?");
    values.push(JSON.stringify(updates.tags));
  }
  
  values.push(id);
  db.run(`UPDATE notes SET ${setClauses.join(", ")} WHERE id = ?`, values);
}

/**
 * Delete a note
 */
export function deleteNote(db: Database, id: string): void {
  db.run("DELETE FROM notes WHERE id = ?", [id]);
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    author: row.author,
    title: row.title,
    content: row.content,
    category: row.category || undefined,
    tags: JSON.parse(row.tags || "[]"),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ============================================
// Task Comments (Discussions)
// ============================================

export interface TaskCommentRow {
  id: string;
  task_id: string;
  parent_id: string | null;
  content: string;
  author_type: "human" | "arm" | "brain";
  author_id: string;
  author_name: string | null;
  screenshot_path: string | null;
  client: "web" | "mail" | "mcp" | "cli";
  edited: number;
  deleted: number;
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  parentId?: string;
  content: string;
  authorType: "human" | "arm" | "brain";
  authorId: string;
  authorName?: string;
  client: "web" | "mail" | "mcp" | "cli";
  screenshotPath?: string;
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create a new task comment
 */
export function createTaskComment(
  db: Database,
  comment: {
    id: string;
    taskId: string;
    parentId?: string;
    content: string;
    authorType: "human" | "arm" | "brain";
    authorId: string;
    authorName?: string;
    client: "web" | "mail" | "mcp" | "cli";
    screenshotPath?: string;
  }
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO task_comments (id, task_id, parent_id, content, screenshot_path, author_type, author_id, author_name, client, edited, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    [
      comment.id,
      comment.taskId,
      comment.parentId || null,
      comment.content,
      comment.screenshotPath || null,
      comment.authorType,
      comment.authorId,
      comment.authorName || null,
      comment.client,
      now,
      now,
    ]
  );
}

/**
 * Get comments for a task
 */
export function getTaskComments(
  db: Database,
  taskId: string,
  options?: { limit?: number; offset?: number; includeDeleted?: boolean }
): TaskComment[] {
  let query = `SELECT * FROM task_comments WHERE task_id = ?`;
  const params: (string | number)[] = [taskId];

  if (!options?.includeDeleted) {
    query += ` AND deleted = 0`;
  }

  query += ` ORDER BY created_at DESC`;

  if (options?.limit) {
    query += ` LIMIT ?`;
    params.push(options.limit);
  }

  if (options?.offset) {
    query += ` OFFSET ?`;
    params.push(options.offset);
  }

  const rows = db.query(query).all(...params) as TaskCommentRow[];
  return rows.map(rowToTaskComment);
}

/**
 * Get a single comment by ID
 */
export function getTaskComment(db: Database, commentId: string): TaskComment | null {
  const row = db.query("SELECT * FROM task_comments WHERE id = ?").get(commentId) as TaskCommentRow | null;
  return row ? rowToTaskComment(row) : null;
}

/**
 * Update a comment's content
 */
export function updateTaskComment(
  db: Database,
  commentId: string,
  updates: { content?: string; deleted?: boolean }
): void {
  const setClauses: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [new Date().toISOString()];

  if (updates.content !== undefined) {
    setClauses.push("content = ?");
    values.push(updates.content);
    setClauses.push("edited = 1");
  }

  if (updates.deleted !== undefined) {
    setClauses.push("deleted = ?");
    values.push(updates.deleted ? 1 : 0);
  }

  values.push(commentId);
  db.run(`UPDATE task_comments SET ${setClauses.join(", ")} WHERE id = ?`, values);
}

/**
 * Soft delete a comment
 */
export function deleteTaskComment(db: Database, commentId: string): void {
  db.run(
    "UPDATE task_comments SET deleted = 1, updated_at = ? WHERE id = ?",
    [new Date().toISOString(), commentId]
  );
}

/**
 * Update task comment stats (comment_count and last_comment_at)
 */
export function updateTaskCommentStats(db: Database, taskId: string): void {
  const now = new Date().toISOString();
  const result = db.query(
    "SELECT COUNT(*) as count, MAX(created_at) as last_at FROM task_comments WHERE task_id = ? AND deleted = 0"
  ).get(taskId) as { count: number; last_at: string | null };

  db.run(
    "UPDATE tasks SET comment_count = ?, last_comment_at = ?, updated_at = ? WHERE id = ?",
    [result.count, result.last_at, now, taskId]
  );
}

/**
 * Mark comments as read for a user
 */
export function markTaskCommentsRead(
  db: Database,
  taskId: string,
  userId: string,
  lastReadCommentId: string
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO task_comment_reads (task_id, user_id, last_read_comment_id, read_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       last_read_comment_id = excluded.last_read_comment_id,
       read_at = excluded.read_at`,
    [taskId, userId, lastReadCommentId, now]
  );
}

/**
 * Get unread comment count for a user on a task
 */
export function getUnreadCommentCount(db: Database, taskId: string, userId: string): number {
  const readReceipt = db.query(
    "SELECT last_read_comment_id FROM task_comment_reads WHERE task_id = ? AND user_id = ?"
  ).get(taskId, userId) as { last_read_comment_id: string } | null;

  if (!readReceipt) {
    // No read receipt - count all non-deleted comments
    const result = db.query(
      "SELECT COUNT(*) as count FROM task_comments WHERE task_id = ? AND deleted = 0"
    ).get(taskId) as { count: number };
    return result.count;
  }

  // Count comments created after the last read comment
  const lastReadAt = db.query(
    "SELECT created_at FROM task_comments WHERE id = ?"
  ).get(readReceipt.last_read_comment_id) as { created_at: string } | null;

  if (!lastReadAt) {
    return 0;
  }

  const result = db.query(
    "SELECT COUNT(*) as count FROM task_comments WHERE task_id = ? AND deleted = 0 AND created_at > ?"
  ).get(taskId, lastReadAt.created_at) as { count: number };

  return result.count;
}

/**
 * Get total comment count for a task
 */
export function getTaskCommentCount(db: Database, taskId: string): number {
  const result = db.query(
    "SELECT COUNT(*) as count FROM task_comments WHERE task_id = ? AND deleted = 0"
  ).get(taskId) as { count: number };
  return result.count;
}

function rowToTaskComment(row: TaskCommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    parentId: row.parent_id || undefined,
    content: row.content,
    screenshotPath: row.screenshot_path || undefined,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name || undefined,
    client: row.client,
    edited: row.edited === 1,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
