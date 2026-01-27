# Task: Database Migration and Shared Types for Task Discussions

## Overview
This is the FOUNDATION task for the Task Discussions feature. You are creating the database schema and TypeScript types that ALL other tasks will depend on. This must be completed first before any other work begins.

## Context

Octopai is an AI agent orchestrator with:
- SQLite as the system of record (located at `~/.octopai/octopai.db`)
- Tasks stored in the `tasks` table
- Arms (AI agents) that claim and work on tasks
- Humans interact via Mail, Web UI, and CLI
- Agents interact via MCP (Model Context Protocol) tools

We need to add threaded discussions to tasks so humans and agents can collaborate.

## What You're Building

### 1. Database Migration (Migration 020)

Add this migration to `src/db/index.ts` following the existing pattern (see MIGRATION_018, MIGRATION_019 as examples).

Create these tables:

```sql
-- Task comments table (threaded discussions)
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'arm', 'brain')),
  author_id TEXT NOT NULL, -- user email, arm_id, or 'brain'
  author_name TEXT, -- display name (optional, for humans)
  content TEXT NOT NULL,
  parent_id TEXT, -- for threaded replies (null = top-level)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  mail_ref TEXT, -- reference to mail message ID if from email
  metadata TEXT DEFAULT '{}' -- JSON: {client: 'web'|'mail'|'mcp'|'cli', ...}
);

-- Indexes for task comments
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_parent ON task_comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_comments_created ON task_comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_comments_author ON task_comments(author_type, author_id);

-- Read receipts for humans (track which comments they've seen)
CREATE TABLE IF NOT EXISTS task_comment_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, -- email address
  task_id TEXT NOT NULL,
  last_read_comment_id TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_reads_user ON task_comment_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_comment_reads_task ON task_comment_reads(task_id);

-- Mail thread mapping (link incoming mail to task discussions)
CREATE TABLE IF NOT EXISTS mail_thread_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_message_id TEXT NOT NULL UNIQUE,
  mail_thread_id TEXT, -- In-Reply-To chain
  task_id TEXT NOT NULL,
  comment_id TEXT, -- null until processed
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mail_thread_map_mail ON mail_thread_map(mail_message_id);
CREATE INDEX IF NOT EXISTS idx_mail_thread_map_task ON mail_thread_map(task_id);
CREATE INDEX IF NOT EXISTS idx_mail_thread_map_thread ON mail_thread_map(mail_thread_id) WHERE mail_thread_id IS NOT NULL;
```

Also add these columns to the tasks table:
```sql
ALTER TABLE tasks ADD COLUMN comment_count INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_comment_at TEXT;
```

### 2. Database Helper Functions

Add these functions to `src/db/state.ts` (following the pattern of existing functions like `createNote`, `getNotes`):

```typescript
// Create a new task comment
export function createTaskComment(
  db: Database,
  comment: {
    id: string;
    taskId: string;
    authorType: 'human' | 'arm' | 'brain';
    authorId: string;
    authorName?: string;
    content: string;
    parentId?: string;
    mailRef?: string;
    metadata?: Record<string, unknown>;
  }
): void;

// Get comments for a task (with optional threading)
export function getTaskComments(
  db: Database,
  taskId: string,
  options?: { 
    limit?: number; 
    offset?: number;
    includeReplies?: boolean;
  }
): TaskComment[];

// Update a comment (for editing)
export function updateTaskComment(
  db: Database,
  commentId: string,
  updates: { content: string }
): void;

// Soft delete a comment
export function deleteTaskComment(
  db: Database,
  commentId: string
): void;

// Update task comment count and last_comment_at
export function updateTaskCommentStats(
  db: Database,
  taskId: string
): void;

// Mark comments as read for a user
export function markTaskCommentsRead(
  db: Database,
  userId: string,
  taskId: string,
  lastReadCommentId: string
): void;

// Get unread count for a user on a task
export function getUnreadCommentCount(
  db: Database,
  userId: string,
  taskId: string
): number;

// Mail thread mapping functions
export function storeMailThreadMap(
  db: Database,
  mapping: {
    mailMessageId: string;
    mailThreadId?: string;
    taskId: string;
    commentId?: string;
  }
): void;

export function getMailThreadMap(
  db: Database,
  mailMessageId: string
): { taskId: string; commentId?: string } | null;

export function updateMailThreadMapComment(
  db: Database,
  mailMessageId: string,
  commentId: string
): void;
```

### 3. TypeScript Types

Add these types to `src/types/index.ts`:

```typescript
// Task comment (discussion entry)
export interface TaskComment {
  id: string;
  taskId: string;
  authorType: 'human' | 'arm' | 'brain';
  authorId: string;
  authorName?: string;
  content: string;
  parentId?: string;
  createdAt: Date;
  updatedAt: Date;
  edited: boolean;
  deleted: boolean;
  mailRef?: string;
  metadata: {
    client: 'web' | 'mail' | 'mcp' | 'cli';
    [key: string]: unknown;
  };
  // Joined fields (populated when fetching)
  replies?: TaskComment[];
}

// Read receipt for tracking unread comments
export interface TaskCommentRead {
  id: number;
  userId: string;
  taskId: string;
  lastReadCommentId: string;
  readAt: Date;
}

// Mail thread mapping
export interface MailThreadMap {
  id: number;
  mailMessageId: string;
  mailThreadId?: string;
  taskId: string;
  commentId?: string;
  processedAt?: Date;
  createdAt: Date;
}

// Discussion summary for task lists
export interface TaskDiscussionSummary {
  taskId: string;
  totalCount: number;
  unreadCount: number;
  lastCommentAt: Date;
  lastCommentPreview: string;
}

// Extend existing Task interface (add these fields)
export interface Task {
  // ... existing fields ...
  commentCount: number;
  lastCommentAt?: Date;
}
```

## Implementation Steps

1. **Read existing code** to understand the patterns:
   - Look at `src/db/index.ts` to see how migrations are structured (MIGRATION_018, MIGRATION_019)
   - Look at `src/db/state.ts` to see how database helper functions are written
   - Look at `src/types/index.ts` to see how types are defined

2. **Add the migration** to `src/db/index.ts`:
   - Create `MIGRATION_020` constant with all SQL
   - Add it to the `MIGRATIONS` array
   - The migration system will auto-run on next server start

3. **Add helper functions** to `src/db/state.ts`:
   - Follow the exact pattern of existing functions
   - Use parameterized queries (NEVER string concatenation for SQL)
   - Handle JSON parsing/stringifying for metadata fields
   - Use snake_case for column names, camelCase for TypeScript

4. **Add types** to `src/types/index.ts`:
   - Place near the existing `Note` interface
   - Use camelCase for property names
   - Use Date objects (not strings) for timestamps
   - Add JSDoc comments for clarity

5. **Test the migration**:
   - Run `bun run typecheck` to ensure TypeScript is valid
   - Start the server to verify migration runs without errors
   - Check that tables are created correctly in SQLite

## Critical Requirements

- **SQLite only**: Do not use any other database
- **Parameterized queries**: Always use `?` placeholders, never string concatenation
- **snake_case columns**: Database columns use snake_case (e.g., `task_id`)
- **camelCase TypeScript**: TypeScript properties use camelCase (e.g., `taskId`)
- **JSON fields**: Store objects as JSON strings in TEXT columns
- **Soft deletes**: Use `deleted` integer column (0/1), don't actually delete rows
- **Threading support**: `parent_id` allows nested replies

## Success Criteria

- [ ] Migration runs successfully on server start
- [ ] All tables and indexes are created
- [ ] Helper functions work correctly (test with simple queries)
- [ ] TypeScript types compile without errors
- [ ] `bun run typecheck` passes

## Files to Modify

1. `src/db/index.ts` - Add MIGRATION_020
2. `src/db/state.ts` - Add helper functions
3. `src/types/index.ts` - Add TypeScript types

## Notes for Future Tasks

The next tasks will depend on this work:
- **CLI/API Task**: Will use these types and DB functions to build REST endpoints
- **Web Task**: Will use these types for the discussion UI
- **Brain/MCP Task**: Will use these types for MCP tools

Make sure the interfaces are clean and well-documented - other developers will be using them!
