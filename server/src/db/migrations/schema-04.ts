export const MIGRATION_057 = `
-- Checklist items table for task sub-task breakdown
CREATE TABLE IF NOT EXISTS task_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);


-- Index for fast lookup by task
CREATE INDEX IF NOT EXISTS idx_checklist_task ON task_checklist_items(task_id);

-- Index for ordering within a task
CREATE INDEX IF NOT EXISTS idx_checklist_sort ON task_checklist_items(task_id, sort_order);
`;


// Migration 035: Fix sort_order to use ascending order (0 = top, 1 = next, etc.)
// Previously used descending order where higher values appeared first
export const MIGRATION_035_FIX_SORT_ORDER = `
-- Update all tasks to use ascending sort_order
-- First, get all tasks ordered by current sort_order DESC (so highest becomes first)
-- Then assign new sort_order values starting from 0
WITH ordered_tasks AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY COALESCE(sort_order, 0) DESC, created_at DESC) - 1 as new_sort_order
  FROM tasks
)
UPDATE tasks
SET sort_order = (
  SELECT new_sort_order
  FROM ordered_tasks
  WHERE ordered_tasks.id = tasks.id
);
`;

// Migration 036: Add sort_order and metadata to bugs table
export const MIGRATION_036_COLUMNS = [
  { name: 'sort_order', sql: "ALTER TABLE bugs ADD COLUMN sort_order INTEGER DEFAULT 0" },
  { name: 'metadata', sql: "ALTER TABLE bugs ADD COLUMN metadata TEXT DEFAULT '{}'" },
];

export const MIGRATION_036 = `
  -- Create index for ordering bugs by their sort order
  CREATE INDEX IF NOT EXISTS idx_bugs_sort_order ON bugs(sort_order);

  -- Initialize sort_order for existing bugs based on created_at
  WITH ordered_bugs AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) - 1 as new_sort_order
    FROM bugs
  )
UPDATE bugs
SET sort_order = (
  SELECT new_sort_order
  FROM ordered_bugs
  WHERE ordered_bugs.id = bugs.id
);
`;

// Migration 037: Add 'completing' status to tasks table for peer validation workflow
export const MIGRATION_037 = `
-- SQLite doesn't support altering CHECK constraints directly
-- We need to recreate the table to add 'completing' status

DROP TABLE IF EXISTS tasks_new;

CREATE TABLE IF NOT EXISTS tasks_new (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'in_progress', 'completing', 'completed', 'failed', 'blocked', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'plan', 'email', 'discovery', 'proposal')),
  source_ref TEXT,
  phase TEXT,
  domain TEXT,
  assigned_to TEXT,
  verification_status TEXT DEFAULT 'none',
  verifying_arm_id TEXT,
  verified_at TEXT,
  verification_notes TEXT,
  verification_artifacts TEXT DEFAULT '[]',
  verification_requested_at TEXT,
  assigned_arms TEXT DEFAULT '[]',
  is_watch_mode INTEGER DEFAULT 0,
  consensus_status TEXT,
  dependency_blocked INTEGER DEFAULT 0,
  plan_line_uid TEXT,
  tags TEXT DEFAULT '[]',
  comment_count INTEGER DEFAULT 0,
  last_comment_at TEXT,
  sort_order INTEGER DEFAULT 0,
  classification TEXT,
  mail_thread_id TEXT,
  context TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  claimed_at TEXT,
  started_at TEXT,
  due_date TEXT,
  artifacts TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}'
);

-- Copy data from old table
INSERT INTO tasks_new (
  id,
  subject,
  description,
  status,
  priority,
  source_type,
  source_ref,
  phase,
  domain,
  assigned_to,
  verification_status,
  verifying_arm_id,
  verified_at,
  verification_notes,
  verification_artifacts,
  verification_requested_at,
  assigned_arms,
  is_watch_mode,
  consensus_status,
  dependency_blocked,
  plan_line_uid,
  tags,
  comment_count,
  last_comment_at,
  sort_order,
  classification,
  mail_thread_id,
  context,
  created_at,
  updated_at,
  completed_at,
  claimed_at,
  started_at,
  due_date,
  artifacts,
  metadata
)
SELECT
  id,
  subject,
  description,
  status,
  priority,
  source_type,
  source_ref,
  phase,
  domain,
  assigned_to,
  verification_status,
  verifying_arm_id,
  verified_at,
  verification_notes,
  verification_artifacts,
  verification_requested_at,
  assigned_arms,
  is_watch_mode,
  consensus_status,
  dependency_blocked,
  plan_line_uid,
  tags,
  comment_count,
  last_comment_at,
  sort_order,
  classification,
  mail_thread_id,
  context,
  created_at,
  updated_at,
  completed_at,
  claimed_at,
  started_at,
  due_date,
  artifacts,
  metadata
FROM tasks;

-- Drop old table and rename new one
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_type);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_verification_status ON tasks(verification_status);
CREATE INDEX IF NOT EXISTS idx_tasks_verifying_arm ON tasks(verifying_arm_id);
CREATE INDEX IF NOT EXISTS idx_tasks_plan_line_uid ON tasks(plan_line_uid);
CREATE INDEX IF NOT EXISTS idx_tasks_classification ON tasks(classification) WHERE classification IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_mail_thread ON tasks(mail_thread_id) WHERE mail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags);
CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(sort_order);
`;

// Migration 038: Fix discoveries table CHECK constraint to include exploration kinds
export const MIGRATION_038 = `
-- SQLite doesn't support altering CHECK constraints directly
-- We need to recreate the table to add exploration discovery kinds

DROP TABLE IF EXISTS discoveries_new;

CREATE TABLE IF NOT EXISTS discoveries_new (
  id TEXT PRIMARY KEY,
  arm_id TEXT NOT NULL,
  arm_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('test_failure', 'unused_code', 'security_issue', 'performance', 'pattern', 'missing_context', 'ambiguous_requirement', 'potential_blocker', 'related_code', 'suggested_approach', 'other')),
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  phase TEXT DEFAULT 'implementation' CHECK (phase IN ('exploration', 'implementation', 'verification')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

-- Copy data from old table
INSERT INTO discoveries_new (
  id, arm_id, arm_name, kind, title, details, file_path, line_number,
  severity, task_id, phase, status, created_at, updated_at, metadata
)
SELECT
  id, arm_id, arm_name, kind, title, details, file_path, line_number,
  severity, task_id, phase, status, created_at, updated_at, metadata
FROM discoveries;

-- Drop old table and rename new one
DROP TABLE discoveries;
ALTER TABLE discoveries_new RENAME TO discoveries;

-- Recreate the FTS5 virtual table
DROP TABLE IF EXISTS discoveries_fts;
CREATE VIRTUAL TABLE IF NOT EXISTS discoveries_fts USING fts5(
  title,
  details,
  content='discoveries',
  content_rowid='rowid'
);

-- Recreate triggers
CREATE TRIGGER IF NOT EXISTS discoveries_ai AFTER INSERT ON discoveries BEGIN
  INSERT INTO discoveries_fts(rowid, title, details) VALUES (new.rowid, new.title, new.details);
END;

CREATE TRIGGER IF NOT EXISTS discoveries_ad AFTER DELETE ON discoveries BEGIN
  INSERT INTO discoveries_fts(discoveries_fts, rowid, title, details) VALUES('delete', old.rowid, old.title, old.details);
END;

CREATE TRIGGER IF NOT EXISTS discoveries_au AFTER UPDATE ON discoveries BEGIN
  INSERT INTO discoveries_fts(discoveries_fts, rowid, title, details) VALUES('delete', old.rowid, old.title, old.details);
  INSERT INTO discoveries_fts(rowid, title, details) VALUES (new.rowid, new.title, new.details);
END;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_discoveries_arm ON discoveries(arm_id);
CREATE INDEX IF NOT EXISTS idx_discoveries_kind ON discoveries(kind);
CREATE INDEX IF NOT EXISTS idx_discoveries_severity ON discoveries(severity);
CREATE INDEX IF NOT EXISTS idx_discoveries_status ON discoveries(status);
CREATE INDEX IF NOT EXISTS idx_discoveries_file ON discoveries(file_path);
CREATE INDEX IF NOT EXISTS idx_discoveries_created ON discoveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_task ON discoveries(task_id);
CREATE INDEX IF NOT EXISTS idx_discoveries_phase ON discoveries(phase);
`;

  /**
 * Seed development data for testing
 */

export const MIGRATION_058_COLUMNS = [
  { name: 'blocked_at', sql: "ALTER TABLE tasks ADD COLUMN blocked_at TEXT" },
];

export const MIGRATION_058 = `
-- Create index for finding blocked tasks by time
CREATE INDEX IF NOT EXISTS idx_tasks_blocked_at ON tasks(blocked_at);

-- Create escalation_tracking table for bug-blocking escalation state
CREATE TABLE IF NOT EXISTS escalation_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  bug_id TEXT NOT NULL,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  last_escalated_at TEXT,
  notified_human INTEGER DEFAULT 0,
  auto_assigned_bug INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (bug_id) REFERENCES bugs(id) ON DELETE CASCADE
);

-- Index for fast lookup of escalations by task
CREATE INDEX IF NOT EXISTS idx_escalation_task ON escalation_tracking(task_id);

-- Index for fast lookup of escalations by bug
CREATE INDEX IF NOT EXISTS idx_escalation_bug ON escalation_tracking(bug_id);
`;

export const MIGRATION_059 = `
-- Migration 047 used a lowercase-uppercase-digit alphabet that does not match
-- SQLite BINARY collation. Re-key active queues from their preserved numeric
-- order so every order_key consumer observes the same sequence.
WITH ordered_tasks AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      ORDER BY COALESCE(sort_order, 2147483647) ASC, created_at ASC, id ASC
    ) as row_num
  FROM tasks
  WHERE status IN ('pending', 'claimed', 'in_progress', 'completing', 'blocked')
),
key_mapping AS (
  SELECT id, printf('a%010d', row_num) as new_order_key
  FROM ordered_tasks
)
UPDATE tasks
SET order_key = (
  SELECT new_order_key
  FROM key_mapping
  WHERE key_mapping.id = tasks.id
)
WHERE id IN (SELECT id FROM key_mapping);
`;

export const MIGRATION_060_COLUMNS = [
	{ name: "blocked_reason", sql: "ALTER TABLE tasks ADD COLUMN blocked_reason TEXT" },
	{ name: "blocked_category", sql: "ALTER TABLE tasks ADD COLUMN blocked_category TEXT" },
	{ name: "blocked_recheck_at", sql: "ALTER TABLE tasks ADD COLUMN blocked_recheck_at TEXT" },
	{ name: "blocked_last_checked_at", sql: "ALTER TABLE tasks ADD COLUMN blocked_last_checked_at TEXT" },
	{ name: "blocked_review_count", sql: "ALTER TABLE tasks ADD COLUMN blocked_review_count INTEGER NOT NULL DEFAULT 0" },
	{ name: "blocked_needs_human", sql: "ALTER TABLE tasks ADD COLUMN blocked_needs_human INTEGER NOT NULL DEFAULT 0" },
	{ name: "blocked_human_notified_at", sql: "ALTER TABLE tasks ADD COLUMN blocked_human_notified_at TEXT" },
	{ name: "blocked_review_arm_id", sql: "ALTER TABLE tasks ADD COLUMN blocked_review_arm_id TEXT" },
	{ name: "blocked_review_started_at", sql: "ALTER TABLE tasks ADD COLUMN blocked_review_started_at TEXT" },
];

export const MIGRATION_060 = `
-- Old blocked rows predate the reason invariant. Give them an explicit legacy
-- reason and make them immediately eligible for review.
UPDATE tasks
SET blocked_reason = COALESCE(NULLIF(TRIM(blocked_reason), ''), 'Blocked before reasons were required'),
    blocked_category = COALESCE(NULLIF(TRIM(blocked_category), ''), 'unknown'),
    blocked_at = COALESCE(blocked_at, updated_at, datetime('now')),
    blocked_recheck_at = COALESCE(blocked_recheck_at, datetime('now'))
WHERE status = 'blocked';

CREATE INDEX IF NOT EXISTS idx_tasks_blocked_recheck
ON tasks(status, blocked_recheck_at, blocked_at);

CREATE TRIGGER IF NOT EXISTS tasks_blocked_reason_insert
BEFORE INSERT ON tasks
WHEN NEW.status = 'blocked' AND TRIM(COALESCE(NEW.blocked_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'blocked tasks require a reason');
END;

CREATE TRIGGER IF NOT EXISTS tasks_blocked_reason_update
BEFORE UPDATE ON tasks
WHEN NEW.status = 'blocked' AND TRIM(COALESCE(NEW.blocked_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'blocked tasks require a reason');
END;
`;

export const MIGRATION_061_ARM_METRIC_HISTORY = `
CREATE TABLE IF NOT EXISTS arm_metric_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  context_used INTEGER NOT NULL,
  context_budget INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  total_cost REAL NOT NULL,
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_arm_metric_history_arm_time
ON arm_metric_history(arm_id, timestamp DESC);
`;

export const MIGRATION_062_ARM_MESSAGE_METRICS = `
CREATE TABLE IF NOT EXISTS arm_message_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  context_used INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE,
  UNIQUE (arm_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_arm_message_metrics_arm_time
ON arm_message_metrics(arm_id, timestamp DESC);
`;

