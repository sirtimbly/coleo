/**
 * Database initialization and migrations
 */
import { Database } from "bun:sqlite";
import { mkdir } from "fs/promises";
import { dirname } from "path";

/**
 * Initialize the database with WAL mode and run migrations
 */
export async function initDatabase(dbPath: string): Promise<Database> {
  // Ensure directory exists
  await mkdir(dirname(dbPath), { recursive: true });

  // Open database with WAL mode for better concurrency
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Run migrations
  await runMigrations(db);

  return db;
}

/**
 * Run all pending migrations
 */
async function runMigrations(db: Database): Promise<void> {
  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get applied migrations
  const applied = new Set(
    (db.query("SELECT name FROM _migrations").all() as { name: string }[]).map(r => r.name)
  );

  // Helper to check if a column exists in a table
  const columnExists = (table: string, column: string): boolean => {
    try {
      const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      return cols.some(c => c.name === column);
    } catch {
      return false;
    }
  };

  // Helper to safely add columns (SQLite doesn't support IF NOT EXISTS for ALTER TABLE)
  const addColumnsIfNotExist = (table: string, columns: { name: string; sql: string }[]) => {
    for (const col of columns) {
      if (!columnExists(table, col.name)) {
        try {
          db.exec(col.sql);
        } catch (err) {
          // Column might already exist due to partial migration
          console.log(`Note: Column ${col.name} may already exist: ${err}`);
        }
      }
    }
  };

  // Define migrations in order
  const migrations: [string, string, { table: string; columns: { name: string; sql: string }[] }?][] = [
    ["001_initial_schema", MIGRATION_001],
    ["002_add_proposals", MIGRATION_002],
    ["003_add_claims", MIGRATION_003],
    ["004_arm_personality", MIGRATION_004],
    ["005_tick_based_timeouts", MIGRATION_005],
    ["006_arm_spawn_fields", MIGRATION_006],
    ["007_fix_status_constraint", MIGRATION_007],
    ["008_arm_heartbeat", MIGRATION_008],
    ["009_file_subscriptions", MIGRATION_009],
    ["010_tasks_table", MIGRATION_010],
    ["011_arm_port", MIGRATION_011],
    ["012_arm_tokens_cost", MIGRATION_012],
    ["013_arm_current_task", MIGRATION_013],
    ["014_arm_agent_host", MIGRATION_014],
    ["015_discoveries", MIGRATION_015],
    ["016_doc_updates", MIGRATION_016],
    ["017_context_compression", MIGRATION_017],
    ["018_task_verification", MIGRATION_018, { table: "tasks", columns: MIGRATION_018_COLUMNS }],
    ["019_task_dependencies", MIGRATION_019],
    ["020_multi_arm_assignment", MIGRATION_020, { table: "tasks", columns: MIGRATION_020_COLUMNS }],
    ["021_status_reports", MIGRATION_021],
    ["022_infrastructure_health", MIGRATION_022],
  ];


  // Apply pending migrations
  for (const [name, sql, columnDefs] of migrations) {
    if (applied.has(name)) continue;

    console.log(`Applying migration: ${name}`);
    
    // First add any columns that need to be added (before running main SQL)
    if (columnDefs) {
      addColumnsIfNotExist(columnDefs.table, columnDefs.columns);
    }
    
    db.exec(sql);
    db.run("INSERT INTO _migrations (name) VALUES (?)", [name]);
  }
}

// Migration 001: Initial schema
const MIGRATION_001 = `
-- Arms table
CREATE TABLE IF NOT EXISTS arms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'paused', 'error', 'stopped')),
  context_budget INTEGER NOT NULL DEFAULT 100000,
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
  ('context_claim_mode', 'lazy');
`;

// Migration 002: Proposals table
const MIGRATION_002 = `
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
const MIGRATION_003 = `
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
const MIGRATION_004 = `
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
const MIGRATION_005 = `
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
const MIGRATION_006 = `
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
  context_budget INTEGER NOT NULL DEFAULT 100000,
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
const MIGRATION_007 = `
-- SQLite doesn't support altering CHECK constraints directly
-- We need to recreate the table to add 'starting' and 'running' status values

-- Create new table with updated constraint
CREATE TABLE IF NOT EXISTS arms_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'paused', 'error', 'stopped', 'starting', 'running')),
  context_budget INTEGER NOT NULL DEFAULT 100000,
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
const MIGRATION_008 = `
-- Add last_heartbeat column for tracking arm liveness
-- Arms should call heartbeat MCP tool periodically; brain marks stale arms as stopped
ALTER TABLE arms ADD COLUMN last_heartbeat TEXT;

-- Add config for heartbeat timeout (seconds)
INSERT OR IGNORE INTO config (key, value) VALUES
  ('arm_heartbeat_timeout_seconds', '120');
`;

// Migration 009: File subscriptions for file watching
const MIGRATION_009 = `
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
const MIGRATION_010 = `
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
const MIGRATION_011 = `
-- Add port column to arms for session recovery after server restart
ALTER TABLE arms ADD COLUMN port INTEGER;
`;

// Migration 012: Add tokens and cost tracking for arms
const MIGRATION_012 = `
-- Add token usage and cost tracking columns
ALTER TABLE arms ADD COLUMN total_tokens INTEGER DEFAULT 0;
ALTER TABLE arms ADD COLUMN total_cost REAL DEFAULT 0;
ALTER TABLE arms ADD COLUMN current_task_id TEXT;
`;

const MIGRATION_013 = `
-- Add current_task_subject for easy display without joining
ALTER TABLE arms ADD COLUMN current_task_subject TEXT;
`;

// Migration 014: Add agent_id and host for distributed arm management
const MIGRATION_014 = `
-- Add agent_id and host columns for distributed arm management
-- agent_id: the ArmAgent that spawned/manages this arm
-- host: the hostname where the arm is running (for display/debugging)
ALTER TABLE arms ADD COLUMN agent_id TEXT;
ALTER TABLE arms ADD COLUMN host TEXT;

-- Index for looking up arms by agent
CREATE INDEX IF NOT EXISTS idx_arms_agent ON arms(agent_id);
`;

// Migration 015: Add discoveries table for cataloging arm discoveries
const MIGRATION_015 = `
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
const MIGRATION_016 = `
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
const MIGRATION_017 = `
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
ALTER TABLE arms ADD COLUMN context_budget_total INTEGER DEFAULT 128000;
ALTER TABLE arms ADD COLUMN context_budget_used REAL DEFAULT 0;

-- Context budget thresholds config
INSERT OR IGNORE INTO config (key, value) VALUES
  ('context_soft_threshold', '0.80'),
  ('context_hard_threshold', '0.95'),
  ('context_compression_enabled', 'true');
`;

// Migration 018: Task verification workflow
// Note: Uses a function-based approach since SQLite doesn't support ADD COLUMN IF NOT EXISTS
const MIGRATION_018 = `
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
const MIGRATION_018_COLUMNS = [
  { name: 'verification_status', sql: "ALTER TABLE tasks ADD COLUMN verification_status TEXT DEFAULT 'none'" },
  { name: 'verifying_arm_id', sql: "ALTER TABLE tasks ADD COLUMN verifying_arm_id TEXT" },
  { name: 'verified_at', sql: "ALTER TABLE tasks ADD COLUMN verified_at TEXT" },
  { name: 'verification_notes', sql: "ALTER TABLE tasks ADD COLUMN verification_notes TEXT" },
  { name: 'verification_artifacts', sql: "ALTER TABLE tasks ADD COLUMN verification_artifacts TEXT DEFAULT '[]'" },
  { name: 'verification_requested_at', sql: "ALTER TABLE tasks ADD COLUMN verification_requested_at TEXT" },
];

// Migration 019: Task dependencies

const MIGRATION_019 = `
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
const MIGRATION_020_COLUMNS = [
  { name: 'assigned_arms', sql: "ALTER TABLE tasks ADD COLUMN assigned_arms TEXT DEFAULT '[]'" },
  { name: 'is_watch_mode', sql: "ALTER TABLE tasks ADD COLUMN is_watch_mode INTEGER DEFAULT 0" },
  { name: 'consensus_status', sql: "ALTER TABLE tasks ADD COLUMN consensus_status TEXT DEFAULT 'pending'" },
  { name: 'dependency_blocked', sql: "ALTER TABLE tasks ADD COLUMN dependency_blocked INTEGER DEFAULT 0" },
];

const MIGRATION_020 = `
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
const MIGRATION_021 = `
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
const MIGRATION_022 = `
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

  /**
 * Seed development data for testing
 */
export async function seedDatabase(db: Database): Promise<void> {
  console.log("Seeding development data...");

  const now = new Date().toISOString();

  // Create some sample arms
  const sampleArms = [
    {
      id: "arm-explorer",
      name: "explorer",
      domain: "general",
      harness: "opencode-api",
      status: "idle",
      context_budget: 100000,
      current_context_used: 45000,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      personality: "Curious explorer who loves finding new patterns in code",
      convictions: JSON.stringify(["Clean code matters", "Tests are essential"]),
      reputation: 65,
      generation: 1,
      parent_arm_id: null,
      pid: null,
      provider: "github-copilot",
      model: "claude-sonnet-4",
      config: JSON.stringify({ workdir: "~/projects" }),
    },
    {
      id: "arm-frontend-expert",
      name: "frontend-expert",
      domain: "frontend",
      harness: "opencode-api",
      status: "idle",
      context_budget: 150000,
      current_context_used: 62000,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      personality: "Detail-oriented UI specialist focused on accessibility",
      convictions: JSON.stringify(["Accessibility is not optional", "Performance is a feature"]),
      reputation: 72,
      generation: 1,
      parent_arm_id: null,
      pid: null,
      provider: "opencode",
      model: "claude-opus-4",
      config: JSON.stringify({ workdir: "~/projects/web" }),
    },
    {
      id: "arm-backend-architect",
      name: "backend-architect",
      domain: "backend",
      harness: "opencode-api",
      status: "busy",
      context_budget: 200000,
      current_context_used: 125000,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      personality: "Systems thinker focused on scalability and reliability",
      convictions: JSON.stringify(["Data consistency is paramount", "APIs should be versioned"]),
      reputation: 80,
      generation: 2,
      parent_arm_id: "arm-explorer",
      pid: 12345,
      provider: "opencode",
      model: "claude-opus-4",
      config: JSON.stringify({ workdir: "~/projects/api" }),
    },
  ];

  for (const arm of sampleArms) {
    try {
      db.run(`
        INSERT OR IGNORE INTO arms (
          id, name, domain, harness, status, context_budget, current_context_used,
          created_at, updated_at, last_activity_at, personality, convictions,
          reputation, generation, parent_arm_id, pid, provider, model, config
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        arm.id, arm.name, arm.domain, arm.harness, arm.status, arm.context_budget,
        arm.current_context_used, arm.created_at, arm.updated_at, arm.last_activity_at,
        arm.personality, arm.convictions, arm.reputation, arm.generation,
        arm.parent_arm_id, arm.pid, arm.provider, arm.model, arm.config
      ]);
    } catch (err) {
      console.log(`Arm ${arm.name} already exists or error: ${err}`);
    }
  }

  // Create some activity entries
  const sampleActivity = [
    { actor: "brain", action: "started", target: null, details: JSON.stringify({}) },
    { actor: "arm-explorer", action: "registered", target: null, details: JSON.stringify({ domain: "general" }) },
    { actor: "arm-frontend-expert", action: "registered", target: null, details: JSON.stringify({ domain: "frontend" }) },
    { actor: "arm-backend-architect", action: "registered", target: null, details: JSON.stringify({ domain: "backend" }) },
    { actor: "arm-backend-architect", action: "claimed", target: "src/api/server.ts", details: JSON.stringify({ claim_type: "write" }) },
  ];

  for (const entry of sampleActivity) {
    try {
      db.run(`
        INSERT INTO activity (timestamp, actor, action, target, details)
        VALUES (?, ?, ?, ?, ?)
      `, [now, entry.actor, entry.action, entry.target, entry.details]);
    } catch (err) {
      console.log(`Activity entry error: ${err}`);
    }
  }

  // Create a sample proposal
  try {
    db.run(`
      INSERT OR IGNORE INTO proposals (
        id, proposer, type, title, description, status, arguments_for, arguments_against,
        signals, created_at, updated_at, timeout_ticks, ticks_elapsed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      "proposal-001",
      "arm-backend-architect",
      "change",
      "Migrate to PostgreSQL",
      "Proposal to migrate from SQLite to PostgreSQL for better concurrency",
      "open",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify({}),
      now,
      now,
      10,
      2
    ]);
  } catch (err) {
    console.log(`Proposal error: ${err}`);
  }

  // Create some claims
  try {
    db.run(`
      INSERT OR IGNORE INTO claims (arm_id, file_path, claim_type, claimed_at)
      VALUES (?, ?, ?, ?)
    `, ["arm-backend-architect", "src/api/server.ts", "write", now]);
  } catch (err) {
    console.log(`Claim error: ${err}`);
  }

  console.log("Database seeded with development data");
}

export { Database };
