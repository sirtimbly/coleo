export const MIGRATION_031 = `
-- Create index for quick lookup of tasks by plan line UID
CREATE INDEX IF NOT EXISTS idx_tasks_plan_line_uid ON tasks(plan_line_uid);
`;

// Migration 032: Add sort_order for task reordering
export const MIGRATION_032_COLUMNS = [
  { name: 'sort_order', sql: "ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT 0" },
];

export const MIGRATION_032 = `
-- Create index for ordering tasks by their sort order
CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(sort_order);
`;

export const MIGRATION_033_COLUMNS = [
  { name: 'tags', sql: "ALTER TABLE tasks ADD COLUMN tags TEXT DEFAULT '[]'" },
];

export const MIGRATION_033 = `
-- Create index for tag queries
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags);
`;

// Columns to add for migration 034 (task discussions)
export const MIGRATION_034_COLUMNS = [
  { name: 'comment_count', sql: "ALTER TABLE tasks ADD COLUMN comment_count INTEGER DEFAULT 0" },
  { name: 'last_comment_at', sql: "ALTER TABLE tasks ADD COLUMN last_comment_at TEXT" },
];

// Migration 034: Task discussions (comments and threading)
export const MIGRATION_034_TASK_DISCUSSIONS = `
-- Task comments table for discussions
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  parent_id TEXT REFERENCES task_comments(id) ON DELETE CASCADE,
   content TEXT NOT NULL,
  screenshot_path TEXT,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'arm', 'brain')),
  author_id TEXT NOT NULL,
  author_name TEXT,
  client TEXT NOT NULL CHECK (client IN ('web', 'mail', 'mcp', 'cli')),
  edited INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Indexes for task comments
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_parent ON task_comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_created ON task_comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_comments_author ON task_comments(author_type, author_id);

-- Task comment read receipts (for unread counts)
CREATE TABLE IF NOT EXISTS task_comment_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_comment_id TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_comment_reads_task ON task_comment_reads(task_id);
CREATE INDEX IF NOT EXISTS idx_task_comment_reads_user ON task_comment_reads(user_id);

-- Mail thread mapping for email integration
CREATE TABLE IF NOT EXISTS mail_thread_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_message_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  comment_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  mapped_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES task_comments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_thread_map_mail ON mail_thread_map(mail_message_id);
CREATE INDEX IF NOT EXISTS idx_mail_thread_map_task ON mail_thread_map(task_id);
`;

// Migration 039: Add screenshot_path to task_comments for screenshot support
export const MIGRATION_039_COLUMNS = [
  { name: 'screenshot_path', sql: "ALTER TABLE task_comments ADD COLUMN screenshot_path TEXT" },
];

export const MIGRATION_039 = `
  -- Add screenshot_path column to task_comments
  -- Column is added via MIGRATION_039_COLUMNS
  SELECT 1;
`;

// Migration 040: Add current bug tracking to arms
export const MIGRATION_040_COLUMNS = [
  { name: 'current_bug_id', sql: "ALTER TABLE arms ADD COLUMN current_bug_id TEXT" },
  { name: 'current_bug_title', sql: "ALTER TABLE arms ADD COLUMN current_bug_title TEXT" },
];

export const MIGRATION_040 = `
  -- Add index for bug lookups
  CREATE INDEX IF NOT EXISTS idx_arms_current_bug ON arms(current_bug_id);
`;

// Migration 041: Add progress column to tasks table for progress visualization
export const MIGRATION_041_COLUMNS = [
  { name: 'progress', sql: "ALTER TABLE tasks ADD COLUMN progress INTEGER DEFAULT 0" },
];

export const MIGRATION_041 = `
  -- Add index for progress queries
  CREATE INDEX IF NOT EXISTS idx_tasks_progress ON tasks(progress);
`;

// Migration 042: Add task preparation fields for Phase 1.2 Collaborative Planning
export const MIGRATION_042_COLUMNS = [
  { name: 'prepared_by_arm_id', sql: "ALTER TABLE tasks ADD COLUMN prepared_by_arm_id TEXT" },
  { name: 'prepared_at', sql: "ALTER TABLE tasks ADD COLUMN prepared_at TEXT" },
];

export const MIGRATION_042 = `
  -- Add index for prepared task queries
  CREATE INDEX IF NOT EXISTS idx_tasks_prepared_by ON tasks(prepared_by_arm_id);

  -- Add index for prepared tasks (not null = prepared)
  CREATE INDEX IF NOT EXISTS idx_tasks_prepared_at ON tasks(prepared_at);
`;

// Migration 043: Search index for hybrid search
export const MIGRATION_043 = `
  -- Search index table for keyword search
  CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    id,
    type,
    title,
    content,
    metadata,
    created_at,
    updated_at,
    tokenize='porter'
  );
`;

// Migration 044: Restore discovery task/phase columns lost by migration 038 table recreation
export const MIGRATION_044_COLUMNS = [
  { name: "task_id", sql: "ALTER TABLE discoveries ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL" },
  { name: "phase", sql: "ALTER TABLE discoveries ADD COLUMN phase TEXT DEFAULT 'implementation' CHECK (phase IN ('exploration', 'implementation', 'verification'))" },
];

export const MIGRATION_044 = `
  -- Ensure discovery rows have a valid phase
  UPDATE discoveries
  SET phase = 'implementation'
  WHERE phase IS NULL OR phase = '';

  -- Restore indexes used by task-scoped discovery lookups
  CREATE INDEX IF NOT EXISTS idx_discoveries_task ON discoveries(task_id);
  CREATE INDEX IF NOT EXISTS idx_discoveries_phase ON discoveries(phase);
`;

// Migration 045: Track total completed task count in brain_state
export const MIGRATION_045 = `
  ALTER TABLE brain_state ADD COLUMN completed_task_count INTEGER NOT NULL DEFAULT 0;
`;

// Migration 046: Reduce default arm grace period from 5m to 2m.
// Only updates installations that still use the legacy default value.
export const MIGRATION_046 = `
  INSERT OR IGNORE INTO config (key, value) VALUES
    ('brain_arm_grace_period_minutes', '2');

  UPDATE config
  SET value = '2',
      updated_at = datetime('now')
  WHERE key = 'brain_arm_grace_period_minutes'
    AND value = '5';
`;

// Migration 047: Add order_key for robust fractional indexing-based task ordering
// This replaces the integer sort_order with lexicographic keys for efficient drag-and-drop
export const MIGRATION_047_COLUMNS = [
  { name: 'order_key', sql: "ALTER TABLE tasks ADD COLUMN order_key TEXT" },
];

export const MIGRATION_047 = `
-- Create index for ordering tasks by their order_key
CREATE INDEX IF NOT EXISTS idx_tasks_order_key ON tasks(order_key);

-- Backfill order_key from existing sort_order using fixed-width ASCII-sortable keys.
WITH ordered_tasks AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY COALESCE(sort_order, 0) ASC, created_at ASC) as row_num
  FROM tasks
  WHERE status IN ('pending', 'claimed', 'in_progress', 'blocked')
),
key_mapping AS (
  SELECT
    id,
    printf('a%010d', row_num) as new_order_key
  FROM ordered_tasks
)
UPDATE tasks
SET order_key = (
  SELECT new_order_key
  FROM key_mapping
  WHERE key_mapping.id = tasks.id
)
WHERE status IN ('pending', 'claimed', 'in_progress', 'blocked');

-- Set order_key for completed tasks based on completed_at timestamp
-- These will be ordered by completed_at, not by order_key
UPDATE tasks
SET order_key = 'z' || hex(completed_at)
WHERE status = 'completed' AND order_key IS NULL;

-- Set order_key for any remaining tasks (failed, cancelled)
UPDATE tasks
SET order_key = 'zz' || hex(created_at)
WHERE order_key IS NULL;
`;

// Migration 048: Add archived flag to bugs table for filtering resolved bugs
export const MIGRATION_048_COLUMNS = [
  { name: 'archived', sql: "ALTER TABLE bugs ADD COLUMN archived INTEGER DEFAULT 0" },
];

export const MIGRATION_048 = `
-- Create index for filtering archived bugs
CREATE INDEX IF NOT EXISTS idx_bugs_archived ON bugs(archived);

-- Backfill: mark resolved/closed bugs as archived if they're older than 30 days
UPDATE bugs
SET archived = 1
WHERE status IN ('resolved', 'closed')
  AND resolved_at IS NOT NULL
  AND resolved_at < datetime('now', '-30 days');
`;

// Migration 049: Remove legacy SQLite arm_events mirror table.
// JetStream is now the canonical event store for arm transcript/history.
export const MIGRATION_049 = `
DROP TABLE IF EXISTS arm_events;
DELETE FROM config WHERE key = 'arm_events_retention_days';
`;

export const MIGRATION_050 = `
CREATE TABLE IF NOT EXISTS uploaded_media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  access_token TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_uploaded_media_created_at ON uploaded_media(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploaded_media_kind ON uploaded_media(kind);
`;

export const MIGRATION_051_COLUMNS = [
  { name: "source", sql: "ALTER TABLE messages ADD COLUMN source TEXT" },
  { name: "stream_name", sql: "ALTER TABLE messages ADD COLUMN stream_name TEXT" },
  { name: "stream_seq", sql: "ALTER TABLE messages ADD COLUMN stream_seq INTEGER" },
  { name: "dedupe_id", sql: "ALTER TABLE messages ADD COLUMN dedupe_id TEXT" },
];

export const MIGRATION_051 = `
UPDATE messages
SET source = COALESCE(source, 'jetstream')
WHERE source IS NULL;

UPDATE messages
SET dedupe_id = COALESCE(dedupe_id, id)
WHERE dedupe_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_name, stream_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe_id ON messages(dedupe_id) WHERE dedupe_id IS NOT NULL;
`;

export const MIGRATION_052 = `
CREATE VIRTUAL TABLE IF NOT EXISTS bugs_fts USING fts5(
  title,
  content = 'bugs',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS bugs_fts_ai AFTER INSERT ON bugs BEGIN
  INSERT INTO bugs_fts(rowid, title)
  VALUES (new.rowid, new.title);
END;

CREATE TRIGGER IF NOT EXISTS bugs_fts_ad AFTER DELETE ON bugs BEGIN
  INSERT INTO bugs_fts(bugs_fts, rowid, title)
  VALUES ('delete', old.rowid, old.title);
END;

CREATE TRIGGER IF NOT EXISTS bugs_fts_au AFTER UPDATE ON bugs BEGIN
  INSERT INTO bugs_fts(bugs_fts, rowid, title)
  VALUES ('delete', old.rowid, old.title);
  INSERT INTO bugs_fts(rowid, title)
  VALUES (new.rowid, new.title);
END;

INSERT INTO bugs_fts(bugs_fts) VALUES ('rebuild');
`;

export const MIGRATION_053 = `
DROP TRIGGER IF EXISTS bugs_fts_ai;
DROP TRIGGER IF EXISTS bugs_fts_ad;
DROP TRIGGER IF EXISTS bugs_fts_au;
DROP TABLE IF EXISTS bugs_fts;

CREATE VIRTUAL TABLE bugs_fts USING fts5(
  title,
  content = 'bugs',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER bugs_fts_ai AFTER INSERT ON bugs BEGIN
  INSERT INTO bugs_fts(rowid, title)
  VALUES (new.rowid, new.title);
END;

CREATE TRIGGER bugs_fts_ad AFTER DELETE ON bugs BEGIN
  INSERT INTO bugs_fts(bugs_fts, rowid, title)
  VALUES ('delete', old.rowid, old.title);
END;

CREATE TRIGGER bugs_fts_au AFTER UPDATE ON bugs BEGIN
  INSERT INTO bugs_fts(bugs_fts, rowid, title)
  VALUES ('delete', old.rowid, old.title);
  INSERT INTO bugs_fts(rowid, title)
  VALUES (new.rowid, new.title);
END;

INSERT INTO bugs_fts(bugs_fts) VALUES ('rebuild');
`;

export const MIGRATION_054_COLUMNS = [
  {
    name: "workdir",
    sql: "ALTER TABLE arms ADD COLUMN workdir TEXT;",
  },
  {
    name: "last_output_at",
    sql: "ALTER TABLE arms ADD COLUMN last_output_at TEXT;",
  },
];

export const MIGRATION_054 = `
CREATE INDEX IF NOT EXISTS idx_arms_workdir ON arms(workdir);
CREATE INDEX IF NOT EXISTS idx_arms_last_output_at ON arms(last_output_at);
`;


// Migration 055: FTS5 index over tasks (subject + description), mirroring the
// bugs_fts external-content pattern so the search API can find real tasks.
export const MIGRATION_055 = `
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  subject,
  description,
  content = 'tasks',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, subject, description)
  VALUES (new.rowid, new.subject, new.description);
END;

CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, subject, description)
  VALUES ('delete', old.rowid, old.subject, old.description);
END;

CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, subject, description)
  VALUES ('delete', old.rowid, old.subject, old.description);
  INSERT INTO tasks_fts(rowid, subject, description)
  VALUES (new.rowid, new.subject, new.description);
END;

INSERT INTO tasks_fts(tasks_fts) VALUES ('rebuild');
`;

// Migration 056: Task work summaries and diffs, so arms/brain can record
// progress summaries and code diffs on a task as they work, and viewers can
// track what they've already seen (mirrors task_comments/task_comment_reads).
export const MIGRATION_056 = `
CREATE TABLE IF NOT EXISTS task_summaries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  content TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'arm' CHECK (author_type IN ('arm', 'brain', 'human')),
  author_id TEXT NOT NULL,
  author_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_summaries_task ON task_summaries(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_diffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  title TEXT,
  file_path TEXT,
  diff TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  author_type TEXT NOT NULL DEFAULT 'arm' CHECK (author_type IN ('arm', 'brain', 'human')),
  author_id TEXT NOT NULL,
  author_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_diffs_task ON task_diffs(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_diff_views (
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_viewed_diff_id TEXT,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
`;

// Migration 055: Add task checklist items for progress visualization and sub-task breakdown
