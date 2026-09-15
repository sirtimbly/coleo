export const MIGRATION_017 = `
-- Context compression events: track when arms compress context due to budget limits
CREATE TABLE IF NOT EXISTS context_compressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  original_tokens INTEGER NOT NULL,
  compressed_tokens INTEGER NOT NULL,
  compression_ratio REAL NOT NULL,
  removed_content TEXT NOT NULL DEFAULT '[]',
  work_in_progress TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for context compression queries
CREATE INDEX IF NOT EXISTS idx_ctx_comp_arm ON context_compressions(arm_id);
CREATE INDEX IF NOT EXISTS idx_ctx_comp_task ON context_compressions(task_id);
CREATE INDEX IF NOT EXISTS idx_ctx_comp_time ON context_compressions(timestamp DESC);

-- Add context_budget_total and context_budget_used columns to arms
-- These track the total budget allocated vs actual usage for cost optimization
ALTER TABLE arms ADD COLUMN context_budget_total INTEGER DEFAULT 300000;
ALTER TABLE arms ADD COLUMN context_budget_used REAL DEFAULT 0;

-- Context budget thresholds config
INSERT OR IGNORE INTO config (key, value) VALUES
  ('context_soft_threshold', '0.80'),
  ('context_hard_threshold', '0.95'),
  ('context_compression_enabled', 'true');
`;

// Migration 018: Task verification workflow
// Note: Uses a function-based approach since SQLite doesn't support ADD COLUMN IF NOT EXISTS
export const MIGRATION_018 = `
-- Task verification table for audit trail
CREATE TABLE IF NOT EXISTS task_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  notes TEXT,
  artifacts TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_ver_task ON task_verifications(task_id);
CREATE INDEX IF NOT EXISTS idx_task_ver_arm ON task_verifications(arm_id);

-- Add indexes for verification workflow queries (columns added separately)
CREATE INDEX IF NOT EXISTS idx_tasks_verification_status ON tasks(verification_status);
CREATE INDEX IF NOT EXISTS idx_tasks_verifying_arm ON tasks(verifying_arm_id);

-- Config for verification workflow
INSERT OR IGNORE INTO config (key, value) VALUES
  ('verification_required', 'true'),
  ('verification_auto_assign', 'true'),
  ('verification_timeout_hours', '24');
`;

// Columns to add for migration 018 (handled separately due to SQLite limitations)
export const MIGRATION_018_COLUMNS = [
  { name: 'verification_status', sql: "ALTER TABLE tasks ADD COLUMN verification_status TEXT DEFAULT 'none'" },
  { name: 'verifying_arm_id', sql: "ALTER TABLE tasks ADD COLUMN verifying_arm_id TEXT" },
  { name: 'verified_at', sql: "ALTER TABLE tasks ADD COLUMN verified_at TEXT" },
  { name: 'verification_notes', sql: "ALTER TABLE tasks ADD COLUMN verification_notes TEXT" },
  { name: 'verification_artifacts', sql: "ALTER TABLE tasks ADD COLUMN verification_artifacts TEXT DEFAULT '[]'" },
  { name: 'verification_requested_at', sql: "ALTER TABLE tasks ADD COLUMN verification_requested_at TEXT" },
];

// Migration 019: Task dependencies

export const MIGRATION_019 = `
-- Update task_dependencies table for richer dependency tracking
-- Drop any leftover temp table from previous failed runs
DROP TABLE IF EXISTS task_dependencies_old;
DROP TABLE IF EXISTS task_dependencies_new;

-- Rename existing table to old (if it exists)
ALTER TABLE task_dependencies RENAME TO task_dependencies_old;

-- Create new dependencies table with enhanced schema
CREATE TABLE task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  dependency_type TEXT DEFAULT 'finish_to_start' CHECK (dependency_type IN ('finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish')),
  auto_detected INTEGER DEFAULT 1, -- 1 = detected by brain, 0 = explicitly specified
  reason TEXT, -- Why this dependency exists
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, depends_on_task_id)
);

-- Copy existing data from old table (only the columns that existed)
INSERT INTO task_dependencies (task_id, depends_on_task_id, dependency_type, auto_detected, created_at)
SELECT task_id, depends_on_task_id, dependency_type, 1, created_at
FROM task_dependencies_old;

-- Drop old table
DROP TABLE IF EXISTS task_dependencies_old;

-- Add indexes for dependency queries
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on_task_id);

-- Config for dependency workflow
INSERT OR IGNORE INTO config (key, value) VALUES
  ('dependency_auto_detect', 'true');
`;

// Columns to add for migration 020 (handled separately due to SQLite limitations)
export const MIGRATION_020_COLUMNS = [
  { name: 'assigned_arms', sql: "ALTER TABLE tasks ADD COLUMN assigned_arms TEXT DEFAULT '[]'" },
  { name: 'is_watch_mode', sql: "ALTER TABLE tasks ADD COLUMN is_watch_mode INTEGER DEFAULT 0" },
  { name: 'consensus_status', sql: "ALTER TABLE tasks ADD COLUMN consensus_status TEXT DEFAULT 'pending'" },
  { name: 'dependency_blocked', sql: "ALTER TABLE tasks ADD COLUMN dependency_blocked INTEGER DEFAULT 0" },
];

export const MIGRATION_020 = `
-- Task arm consensus/approval tracking
CREATE TABLE IF NOT EXISTS task_arm_consensus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'watcher')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'approved', 'rejected', 'watching')),
  approval TEXT DEFAULT NULL,
  approval_reason TEXT,
  last_report TEXT,
  last_report_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, arm_id)
);

CREATE INDEX IF NOT EXISTS idx_task_consensus_task ON task_arm_consensus(task_id);
CREATE INDEX IF NOT EXISTS idx_task_consensus_arm ON task_arm_consensus(arm_id);
CREATE INDEX IF NOT EXISTS idx_task_consensus_status ON task_arm_consensus(status);

-- Config for multi-arm and consensus workflow
INSERT OR IGNORE INTO config (key, value) VALUES
  ('task_multi_arm_enabled', 'true'),
  ('watch_mode_enabled', 'true'),
  ('consensus_required', 'true'),
  ('max_arms_per_task', '3');
`;

// Migration 021: Status reports for progressive planning
export const MIGRATION_021 = `
-- Status reports from arms during or after task execution
-- Used by brain to re-evaluate plans and create verification tasks
CREATE TABLE IF NOT EXISTS status_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('on_track', 'blocked', 'issues_found', 'needs_review', 'completed_with_issues')),
  summary TEXT NOT NULL,
  issues TEXT DEFAULT '[]',
  blockers TEXT DEFAULT '[]',
  next_steps TEXT,
  files_changed TEXT DEFAULT '[]',
  tests_status TEXT CHECK (tests_status IS NULL OR tests_status IN ('passing', 'failing', 'not_run')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_status_reports_task ON status_reports(task_id);
CREATE INDEX IF NOT EXISTS idx_status_reports_arm ON status_reports(arm_id);
CREATE INDEX IF NOT EXISTS idx_status_reports_status ON status_reports(status);
CREATE INDEX IF NOT EXISTS idx_status_reports_created ON status_reports(created_at DESC);
`;

// Migration 022: Infrastructure health tracking
export const MIGRATION_022 = `
-- Infrastructure health status
-- Updated by brain during poll cycle, read by API server for status endpoint
CREATE TABLE IF NOT EXISTS infrastructure_health (
  component TEXT PRIMARY KEY,
  healthy INTEGER NOT NULL DEFAULT 0,
  optional INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  last_check TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert default components
INSERT OR IGNORE INTO infrastructure_health (component, healthy, optional) VALUES
  ('database', 1, 0),
  ('nats', 0, 1),
  ('maildir', 1, 0),
  ('api_server', 1, 0);
`;

// Migration 023: SQLite state migration - replaces JSON files
// This migration adds tables for brain_state, messages, tools, and notes
// to eliminate JSON file storage and maintain single source of truth
export const MIGRATION_023 = `
-- Brain state table (replaces .octopai/state/brain.json)
-- Single row table for brain coordinator state
CREATE TABLE IF NOT EXISTS brain_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- Ensure only one row
  status TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped', 'running', 'paused')),
  poll_interval_ms INTEGER NOT NULL DEFAULT 30000,
  started_at TEXT,
  last_poll_at TEXT,
  pending_tasks INTEGER NOT NULL DEFAULT 0,
  completed_today INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize with default state
INSERT OR IGNORE INTO brain_state (id, status, poll_interval_ms) VALUES (1, 'stopped', 30000);

-- Messages table (replaces .octopai/queue/ files)
-- Stores messages between brain and arms
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- Tools table (replaces .octopai/state/toolbox.json)
-- Stores tools discovered by arms
CREATE TABLE IF NOT EXISTS tools (
  name TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  description TEXT NOT NULL,
  discovered_by TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tools_discovered_by ON tools(discovered_by);

-- Notes table (replaces .octopai/state/notes/ files)
-- Stores shared notes between arms
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_author ON notes(author);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);

-- Full-text search on notes
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  content,
  content='notes',
  content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`;

// Columns to add for migration 024 (task fields for full Task type support)
export const MIGRATION_024_COLUMNS = [
  { name: 'classification', sql: "ALTER TABLE tasks ADD COLUMN classification TEXT" },
  { name: 'mail_thread_id', sql: "ALTER TABLE tasks ADD COLUMN mail_thread_id TEXT" },
  { name: 'context', sql: "ALTER TABLE tasks ADD COLUMN context TEXT DEFAULT '{}'" },
];

// Migration 024: Add missing task columns for full Task type support
// Supports classification, mail_thread_id, and context fields from src/types/index.ts
export const MIGRATION_024 = `
-- Add index for mail thread lookups
CREATE INDEX IF NOT EXISTS idx_tasks_mail_thread ON tasks(mail_thread_id) WHERE mail_thread_id IS NOT NULL;

-- Add index for classification queries
CREATE INDEX IF NOT EXISTS idx_tasks_classification ON tasks(classification) WHERE classification IS NOT NULL;
`;

// Migration 025: Arm state machine table
export const MIGRATION_025 = `
-- Arm state machine: formal state tracking that survives restarts
-- This replaces the ad-hoc status field with a proper state machine
CREATE TABLE IF NOT EXISTS arm_state_machine (
  arm_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'spawning' CHECK (state IN (
    'spawning', 'starting', 'idle', 'task_assigned', 'working',
    'completing', 'disconnected', 'stopped', 'error'
  )),
  previous_state TEXT,
  current_task_id TEXT,
  current_task_subject TEXT,
  last_event_type TEXT,
  last_event_at TEXT NOT NULL,
  state_entered_at TEXT NOT NULL,
  task_assigned_at TEXT,
  disconnected_at TEXT,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_heartbeat TEXT,
  consecutive_missed_heartbeats INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_arm_sm_state ON arm_state_machine(state);
CREATE INDEX IF NOT EXISTS idx_arm_sm_task ON arm_state_machine(current_task_id);
CREATE INDEX IF NOT EXISTS idx_arm_sm_heartbeat ON arm_state_machine(last_heartbeat);

-- State machine event log for debugging and audit
CREATE TABLE IF NOT EXISTS arm_state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_data TEXT DEFAULT '{}',
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_arm_events_arm ON arm_state_events(arm_id);
CREATE INDEX IF NOT EXISTS idx_arm_events_time ON arm_state_events(timestamp DESC);

-- Config for state machine timeouts (in seconds)
INSERT OR IGNORE INTO config (key, value) VALUES
  ('arm_spawn_timeout_seconds', '60'),
  ('arm_startup_timeout_seconds', '120'),
  ('arm_task_ack_timeout_seconds', '180'),
  ('arm_reconnect_timeout_seconds', '300'),
  ('arm_working_reconnect_timeout_seconds', '600');
`;

// Migration 026: Add session_id to arms table for MCP session isolation
export const MIGRATION_026 = `
-- Add session_id column to track OpenCode session ID for each arm
-- This enables MCP servers to filter events by their own session
ALTER TABLE arms ADD COLUMN session_id TEXT;

-- Index for efficient session lookup
CREATE INDEX IF NOT EXISTS idx_arms_session_id ON arms(session_id);
`;

// Migration 027: Arm events table for storing all OpenCode events
export const MIGRATION_027 = `
-- Arm events table: stores all events from OpenCode sessions
-- This replaces the previous approach of MCP servers listening directly to OpenCode
CREATE TABLE IF NOT EXISTS arm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

-- Indexes for efficient event queries
CREATE INDEX IF NOT EXISTS idx_arm_events_arm ON arm_events(arm_id);
CREATE INDEX IF NOT EXISTS idx_arm_events_session ON arm_events(session_id);
CREATE INDEX IF NOT EXISTS idx_arm_events_type ON arm_events(event_type);
CREATE INDEX IF NOT EXISTS idx_arm_events_time ON arm_events(timestamp DESC);

-- Config for event retention (days)
INSERT OR IGNORE INTO config (key, value) VALUES
  ('arm_events_retention_days', '7');
`;

// Migration 028: Add task_id and phase to discoveries table for exploration-first workflow
export const MIGRATION_028 = `
-- Add task_id column to link discoveries to specific tasks
-- This enables feeding prior discoveries to arms working on related tasks
ALTER TABLE discoveries ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;

-- Add phase column to distinguish exploration vs implementation discoveries
ALTER TABLE discoveries ADD COLUMN phase TEXT DEFAULT 'implementation' CHECK (phase IN ('exploration', 'implementation', 'verification'));

-- Index for efficient task-based discovery queries
CREATE INDEX IF NOT EXISTS idx_discoveries_task ON discoveries(task_id);
CREATE INDEX IF NOT EXISTS idx_discoveries_phase ON discoveries(phase);
`;

// Migration 029: Add last_doc_update config for tracking last documentation update timestamp
export const MIGRATION_029_LAST_DOC_UPDATE = `
-- Add last_doc_update config key for fast access to last documentation update timestamp
INSERT OR IGNORE INTO config (key, value) VALUES
  ('last_doc_update', '');
`;

export const MIGRATION_030_BUG_TRACKING = `
-- Bug tracking table for arm-reported, human-reported, and system-detected bugs
CREATE TABLE IF NOT EXISTS bugs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('arm_reported', 'human_reported', 'system_detected')),
  source_arm_id TEXT REFERENCES arms(id) ON DELETE SET NULL,
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'fixing', 'verifying', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  assignee_arm_id TEXT REFERENCES arms(id) ON DELETE SET NULL,
  blockers TEXT DEFAULT '[]', -- JSON array of blocking task IDs
  error_details TEXT, -- JSON with stack traces, logs, etc.
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  human_notified BOOLEAN DEFAULT FALSE
);

-- Index for efficient bug queries
CREATE INDEX IF NOT EXISTS idx_bugs_source ON bugs(source);
CREATE INDEX IF NOT EXISTS idx_bugs_status ON bugs(status);
CREATE INDEX IF NOT EXISTS idx_bugs_priority ON bugs(priority);
CREATE INDEX IF NOT EXISTS idx_bugs_assignee ON bugs(assignee_arm_id);
CREATE INDEX IF NOT EXISTS idx_bugs_created ON bugs(created_at DESC);
`;

// Migration 031: Add plan_line_uid for linking tasks to plan.md lines
export const MIGRATION_031_COLUMNS = [
  { name: 'plan_line_uid', sql: "ALTER TABLE tasks ADD COLUMN plan_line_uid TEXT" },
];

