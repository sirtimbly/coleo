// Migration 001: Initial schema
export const MIGRATION_001 = `
-- Arms table
CREATE TABLE IF NOT EXISTS arms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'paused', 'error', 'stopped')),
  context_budget INTEGER NOT NULL DEFAULT 300000,
  current_context_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,
  config TEXT NOT NULL DEFAULT '{}'
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity(actor);

-- Config table for system settings
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert default config
INSERT OR IGNORE INTO config (key, value) VALUES
  ('brain_poll_interval_ms', '30000'),
  ('brain_max_arms', '8'),
  ('brain_arm_grace_period_minutes', '2'),
  ('context_claim_mode', 'lazy');
`;

// Migration 002: Proposals table
export const MIGRATION_002 = `
-- Proposals table for governance
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  proposer TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn', 'expired')),
  arguments_for TEXT NOT NULL DEFAULT '[]',
  arguments_against TEXT NOT NULL DEFAULT '[]',
  signals TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution TEXT,
  FOREIGN KEY (proposer) REFERENCES arms(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_proposer ON proposals(proposer);
`;

// Migration 003: File claims table
export const MIGRATION_003 = `
-- File claims for context management
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'read' CHECK (claim_type IN ('read', 'write', 'exclusive')),
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT,
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_claims_arm ON claims(arm_id);
CREATE INDEX IF NOT EXISTS idx_claims_file ON claims(file_path);
CREATE INDEX IF NOT EXISTS idx_claims_active ON claims(released_at) WHERE released_at IS NULL;
`;

// Migration 004: Arm personality and convictions
export const MIGRATION_004 = `
-- Add personality and conviction fields to arms
-- personality: ~200 tokens of self-updating personality context
-- convictions: core beliefs that color the arm's thinking
-- reputation: 0-100 score (starts at 50)
ALTER TABLE arms ADD COLUMN personality TEXT DEFAULT '';
ALTER TABLE arms ADD COLUMN convictions TEXT DEFAULT '[]';
ALTER TABLE arms ADD COLUMN reputation INTEGER DEFAULT 50;
ALTER TABLE arms ADD COLUMN generation INTEGER DEFAULT 1;
ALTER TABLE arms ADD COLUMN parent_arm_id TEXT REFERENCES arms(id);
`;

// Migration 005: Tick-based proposal timeouts
export const MIGRATION_005 = `
-- Add tick-based timeout support to proposals
-- timeout_ticks: number of brain poll cycles before expiry (more flexible than wall-clock)
ALTER TABLE proposals ADD COLUMN timeout_ticks INTEGER DEFAULT 10;
ALTER TABLE proposals ADD COLUMN ticks_elapsed INTEGER DEFAULT 0;

-- Add intervention tracking
CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('warn', 'pause', 'kill')),
  reason TEXT NOT NULL,
  pattern TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interventions_arm ON interventions(arm_id);

-- Add config for intervention thresholds
INSERT OR IGNORE INTO config (key, value) VALUES
  ('intervention_kill_on_critical', 'true'),
  ('intervention_pause_after_violations', '3'),
  ('intervention_warn_window_minutes', '60');
`;

// Migration 006: Add spawn-related fields to arms
export const MIGRATION_006 = `
-- Add fields for spawned arms (PID tracking, provider/model selection)
ALTER TABLE arms ADD COLUMN pid INTEGER;
ALTER TABLE arms ADD COLUMN provider TEXT;
ALTER TABLE arms ADD COLUMN model TEXT;

-- SQLite doesn't support altering CHECK constraints directly
-- We need to recreate the table to add 'starting' and 'running' status values
-- For now, we'll drop and recreate the constraint by recreating the table

-- Create new table with updated constraint
CREATE TABLE arms_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'paused', 'error', 'stopped', 'starting', 'running')),
  context_budget INTEGER NOT NULL DEFAULT 300000,
  current_context_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  personality TEXT DEFAULT '',
  convictions TEXT DEFAULT '[]',
  reputation INTEGER DEFAULT 50,
  generation INTEGER DEFAULT 1,
  parent_arm_id TEXT REFERENCES arms(id),
  pid INTEGER,
  provider TEXT,
  model TEXT
);

-- Copy data from old table
INSERT INTO arms_new SELECT
  id, name, domain, harness, status, context_budget, current_context_used,
  created_at, updated_at, last_activity_at, config, personality, convictions,
  reputation, generation, parent_arm_id, NULL, NULL, NULL
FROM arms;

-- Drop old table and rename new one
DROP TABLE arms;
ALTER TABLE arms_new RENAME TO arms;
`;

// Migration 007: Fix status constraint (for databases that already ran 006 partially)
export const MIGRATION_007 = `
-- SQLite doesn't support altering CHECK constraints directly
-- We need to recreate the table to add 'starting' and 'running' status values

-- Create new table with updated constraint
CREATE TABLE IF NOT EXISTS arms_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'paused', 'error', 'stopped', 'starting', 'running')),
  context_budget INTEGER NOT NULL DEFAULT 300000,
  current_context_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  personality TEXT DEFAULT '',
  convictions TEXT DEFAULT '[]',
  reputation INTEGER DEFAULT 50,
  generation INTEGER DEFAULT 1,
  parent_arm_id TEXT,
  pid INTEGER,
  provider TEXT,
  model TEXT
);

-- Copy data from old table
INSERT OR IGNORE INTO arms_new SELECT
  id, name, domain, harness, status, context_budget, current_context_used,
  created_at, updated_at, last_activity_at, config, personality, convictions,
  reputation, generation, parent_arm_id, pid, provider, model
FROM arms;

-- Drop old table and rename new one
DROP TABLE IF EXISTS arms;
ALTER TABLE arms_new RENAME TO arms;
`;

// Migration 008: Add heartbeat for arm liveness detection
export const MIGRATION_008 = `
-- Add last_heartbeat column for tracking arm liveness
-- Arms should call heartbeat MCP tool periodically; brain marks stale arms as stopped
ALTER TABLE arms ADD COLUMN last_heartbeat TEXT;

-- Add config for heartbeat timeout (seconds)
INSERT OR IGNORE INTO config (key, value) VALUES
  ('arm_heartbeat_timeout_seconds', '120');
`;

// Migration 009: File subscriptions for file watching
export const MIGRATION_009 = `
-- File subscriptions: arms can subscribe to files they want to watch
CREATE TABLE IF NOT EXISTS file_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  file_pattern TEXT NOT NULL,
  category TEXT,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked TEXT,
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_subs_arm ON file_subscriptions(arm_id);
CREATE INDEX IF NOT EXISTS idx_file_subs_pattern ON file_subscriptions(file_pattern);

-- File change history: track changes to watched files
CREATE TABLE IF NOT EXISTS file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('created', 'modified', 'deleted')),
  content_hash TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  detected_by_arm_id TEXT,
  notified_arms TEXT DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(file_path);
CREATE INDEX IF NOT EXISTS idx_file_changes_time ON file_changes(changed_at DESC);
`;

// Migration 010: Tasks table for structured task management
export const MIGRATION_010 = `
-- Tasks table: structured task management with source tracking
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'in_progress', 'completed', 'failed', 'blocked', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'plan', 'email', 'discovery', 'proposal')),
  source_ref TEXT, -- Reference to source (e.g., plan.md section, email thread ID)
  phase TEXT, -- Project phase (Phase 1, Phase 2, etc.)
  domain TEXT, -- Preferred arm domain (frontend, backend, docs, etc.)
  assigned_to TEXT, -- arm_id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  claimed_at TEXT,
  started_at TEXT,
  due_date TEXT,
  artifacts TEXT DEFAULT '[]', -- JSON array of related artifacts
  metadata TEXT DEFAULT '{}', -- Additional metadata (e.g., from plan parsing)
  FOREIGN KEY (assigned_to) REFERENCES arms(id) ON DELETE SET NULL
);

-- Task dependencies (for tracking task relationships)
CREATE TABLE IF NOT EXISTS task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  dependency_type TEXT DEFAULT 'finish_to_start' CHECK (dependency_type IN ('finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, depends_on_task_id)
);

-- Project plan tracking
CREATE TABLE IF NOT EXISTS project_phases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'blocked', 'cancelled')),
  start_date TEXT,
  target_date TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plan file tracking (for auto-updating tasks from plan.md)
CREATE TABLE IF NOT EXISTS plan_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL UNIQUE,
  last_parsed_at TEXT,
  last_hash TEXT, -- Hash of file content at last parse
  parse_errors TEXT DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_type);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on_task_id);

-- Config for task discovery
INSERT OR IGNORE INTO config (key, value) VALUES
  ('task_auto_discover', 'true'),
  ('task_plan_glob_pattern', '.project/plan.md'),
  ('task_todo_glob_pattern', '**/*.todo.md');
`;

// Migration 011: Add port column for session recovery
export const MIGRATION_011 = `
-- Add port column to arms for session recovery after server restart
ALTER TABLE arms ADD COLUMN port INTEGER;
`;

// Migration 012: Add tokens and cost tracking for arms
export const MIGRATION_012 = `
-- Add token usage and cost tracking columns
ALTER TABLE arms ADD COLUMN total_tokens INTEGER DEFAULT 0;
ALTER TABLE arms ADD COLUMN total_cost REAL DEFAULT 0;
ALTER TABLE arms ADD COLUMN current_task_id TEXT;
`;

export const MIGRATION_013 = `
-- Add current_task_subject for easy display without joining
ALTER TABLE arms ADD COLUMN current_task_subject TEXT;
`;

// Migration 014: Add agent_id and host for distributed arm management
export const MIGRATION_014 = `
-- Add agent_id and host columns for distributed arm management
-- agent_id: the ArmAgent that spawned/manages this arm
-- host: the hostname where the arm is running (for display/debugging)
ALTER TABLE arms ADD COLUMN agent_id TEXT;
ALTER TABLE arms ADD COLUMN host TEXT;

-- Index for looking up arms by agent
CREATE INDEX IF NOT EXISTS idx_arms_agent ON arms(agent_id);
`;

// Migration 015: Add discoveries table for cataloging arm discoveries
export const MIGRATION_015 = `
-- Discoveries table: stores discoveries made by arms about their environment
CREATE TABLE IF NOT EXISTS discoveries (
  id TEXT PRIMARY KEY,
  arm_id TEXT NOT NULL,
  arm_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('test_failure', 'unused_code', 'security_issue', 'performance', 'pattern', 'other')),
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_discoveries_arm ON discoveries(arm_id);
CREATE INDEX IF NOT EXISTS idx_discoveries_kind ON discoveries(kind);
CREATE INDEX IF NOT EXISTS idx_discoveries_severity ON discoveries(severity);
CREATE INDEX IF NOT EXISTS idx_discoveries_status ON discoveries(status);
CREATE INDEX IF NOT EXISTS idx_discoveries_file ON discoveries(file_path);
CREATE INDEX IF NOT EXISTS idx_discoveries_created ON discoveries(created_at DESC);

-- Full-text search index on title and details (SQLite FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS discoveries_fts USING fts5(
  title,
  details,
  content='discoveries',
  content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
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
`;

// Migration 016: Doc updates tracking for documentation sync
export const MIGRATION_016 = `
-- Doc updates table: track documentation updates and file changes
CREATE TABLE IF NOT EXISTS doc_updates (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('phase_complete', 'threshold', 'human_request', 'periodic')),
  files_reviewed INTEGER DEFAULT 0,
  docs_updated INTEGER DEFAULT 0,
  future_work_notes_added INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  metadata TEXT DEFAULT '{}'
);

-- Index for looking up recent doc updates
CREATE INDEX IF NOT EXISTS idx_doc_updates_time ON doc_updates(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_updates_status ON doc_updates(status);

-- Config for doc update thresholds
INSERT OR IGNORE INTO config (key, value) VALUES
  ('doc_update_file_threshold', '10'),
  ('doc_update_poll_interval', '10'),
  ('doc_update_enabled', 'true');
`;

// Migration 017: Context compression tracking for Phase 2.7
