/**
 * Database initialization and migrations
 */
import { Database } from "bun:sqlite";
import { mkdir } from "fs/promises";
import { dirname } from "path";

/**
 * Initialize the database with WAL mode and run migrations
 */
const isTestEnv =
  process.env.NODE_ENV === "test" ||
  process.env.BUN_ENV === "test" ||
  process.env.BUN_TEST === "1";
const shouldLogMigrations = !isTestEnv && process.env.COLEO_LOG_MIGRATIONS !== "false";

export async function initDatabase(dbPath: string): Promise<Database> {
  // Ensure directory exists
  await mkdir(dirname(dbPath), { recursive: true });

  // Open database with WAL mode for better concurrency
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000"); // Wait up to 5 seconds if database is locked
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
    ["023_sqlite_state_migration", MIGRATION_023],
    ["024_task_type_columns", MIGRATION_024, { table: "tasks", columns: MIGRATION_024_COLUMNS }],
    ["025_arm_state_machine", MIGRATION_025],
    ["026_arm_session_id", MIGRATION_026],
    ["027_arm_events", MIGRATION_027],
    ["028_discoveries_task_phase", MIGRATION_028],
    ["029_last_doc_update_config", MIGRATION_029_LAST_DOC_UPDATE],
    ["030_bug_tracking", MIGRATION_030_BUG_TRACKING],
    ["031_task_plan_line_uid", MIGRATION_031, { table: "tasks", columns: MIGRATION_031_COLUMNS }],
    ["032_task_sort_order", MIGRATION_032, { table: "tasks", columns: MIGRATION_032_COLUMNS }],
    ["033_task_tags", MIGRATION_033, { table: "tasks", columns: MIGRATION_033_COLUMNS }],
    ["034_task_discussions", MIGRATION_034_TASK_DISCUSSIONS, { table: "tasks", columns: MIGRATION_034_COLUMNS }],
    ["035_fix_sort_order", MIGRATION_035_FIX_SORT_ORDER],
    ["036_bugs_sort_order", MIGRATION_036, { table: "bugs", columns: MIGRATION_036_COLUMNS }],
    ["037_task_completing_status", MIGRATION_037],
    ["038_discovery_kind_constraint", MIGRATION_038],
    ["039_task_comment_screenshot", MIGRATION_039, { table: "task_comments", columns: MIGRATION_039_COLUMNS }],
    ["040_arm_bug_tracking", MIGRATION_040, { table: "arms", columns: MIGRATION_040_COLUMNS }],
    ["041_task_progress", MIGRATION_041, { table: "tasks", columns: MIGRATION_041_COLUMNS }],
    ["042_task_preparation", MIGRATION_042, { table: "tasks", columns: MIGRATION_042_COLUMNS }],
		["043_search_index", MIGRATION_043],
		["044_restore_discoveries_task_phase", MIGRATION_044, { table: "discoveries", columns: MIGRATION_044_COLUMNS }],
		["045_brain_completed_task_count", MIGRATION_045],
		["046_arm_grace_default_2m", MIGRATION_046],
		["047_task_order_key", MIGRATION_047, { table: "tasks", columns: MIGRATION_047_COLUMNS }],
		["048_bugs_archived", MIGRATION_048, { table: "bugs", columns: MIGRATION_048_COLUMNS }],
		["049_remove_arm_events_table", MIGRATION_049],
		["050_uploaded_media", MIGRATION_050],
    ["051_command_projection_metadata", MIGRATION_051, { table: "messages", columns: MIGRATION_051_COLUMNS }],
    ["052_bugs_fts", MIGRATION_052],
		["053_fix_bugs_fts_external_content", MIGRATION_053],
    ["054_arm_runtime_metadata", MIGRATION_054, { table: "arms", columns: MIGRATION_054_COLUMNS }],
		["055_arm_stuck_requests", MIGRATION_055],
	];


  // Apply pending migrations
  for (const [name, sql, columnDefs] of migrations) {
    if (applied.has(name)) continue;

    if (shouldLogMigrations) {
      console.log(`Applying migration: ${name}`);
    }
    
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
  ('brain_arm_grace_period_minutes', '2'),
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

// Migration 023: SQLite state migration - replaces JSON files
// This migration adds tables for brain_state, messages, tools, and notes
// to eliminate JSON file storage and maintain single source of truth
const MIGRATION_023 = `
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
const MIGRATION_024_COLUMNS = [
  { name: 'classification', sql: "ALTER TABLE tasks ADD COLUMN classification TEXT" },
  { name: 'mail_thread_id', sql: "ALTER TABLE tasks ADD COLUMN mail_thread_id TEXT" },
  { name: 'context', sql: "ALTER TABLE tasks ADD COLUMN context TEXT DEFAULT '{}'" },
];

// Migration 024: Add missing task columns for full Task type support
// Supports classification, mail_thread_id, and context fields from src/types/index.ts
const MIGRATION_024 = `
-- Add index for mail thread lookups
CREATE INDEX IF NOT EXISTS idx_tasks_mail_thread ON tasks(mail_thread_id) WHERE mail_thread_id IS NOT NULL;

-- Add index for classification queries
CREATE INDEX IF NOT EXISTS idx_tasks_classification ON tasks(classification) WHERE classification IS NOT NULL;
`;

// Migration 025: Arm state machine table
const MIGRATION_025 = `
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
const MIGRATION_026 = `
-- Add session_id column to track OpenCode session ID for each arm
-- This enables MCP servers to filter events by their own session
ALTER TABLE arms ADD COLUMN session_id TEXT;

-- Index for efficient session lookup
CREATE INDEX IF NOT EXISTS idx_arms_session_id ON arms(session_id);
`;

// Migration 027: Arm events table for storing all OpenCode events
const MIGRATION_027 = `
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
const MIGRATION_028 = `
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
const MIGRATION_029_LAST_DOC_UPDATE = `
-- Add last_doc_update config key for fast access to last documentation update timestamp
INSERT OR IGNORE INTO config (key, value) VALUES
  ('last_doc_update', '');
`;

const MIGRATION_030_BUG_TRACKING = `
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
const MIGRATION_031_COLUMNS = [
  { name: 'plan_line_uid', sql: "ALTER TABLE tasks ADD COLUMN plan_line_uid TEXT" },
];

const MIGRATION_031 = `
-- Create index for quick lookup of tasks by plan line UID
CREATE INDEX IF NOT EXISTS idx_tasks_plan_line_uid ON tasks(plan_line_uid);
`;

// Migration 032: Add sort_order for task reordering
const MIGRATION_032_COLUMNS = [
  { name: 'sort_order', sql: "ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT 0" },
];

const MIGRATION_032 = `
-- Create index for ordering tasks by their sort order
CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(sort_order);
`;

const MIGRATION_033_COLUMNS = [
  { name: 'tags', sql: "ALTER TABLE tasks ADD COLUMN tags TEXT DEFAULT '[]'" },
];

const MIGRATION_033 = `
-- Create index for tag queries
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags);
`;

// Columns to add for migration 034 (task discussions)
const MIGRATION_034_COLUMNS = [
  { name: 'comment_count', sql: "ALTER TABLE tasks ADD COLUMN comment_count INTEGER DEFAULT 0" },
  { name: 'last_comment_at', sql: "ALTER TABLE tasks ADD COLUMN last_comment_at TEXT" },
];

// Migration 034: Task discussions (comments and threading)
const MIGRATION_034_TASK_DISCUSSIONS = `
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
const MIGRATION_039_COLUMNS = [
  { name: 'screenshot_path', sql: "ALTER TABLE task_comments ADD COLUMN screenshot_path TEXT" },
];

const MIGRATION_039 = `
  -- Add screenshot_path column to task_comments
  -- Column is added via MIGRATION_039_COLUMNS
  SELECT 1;
`;

// Migration 040: Add current bug tracking to arms
const MIGRATION_040_COLUMNS = [
  { name: 'current_bug_id', sql: "ALTER TABLE arms ADD COLUMN current_bug_id TEXT" },
  { name: 'current_bug_title', sql: "ALTER TABLE arms ADD COLUMN current_bug_title TEXT" },
];

const MIGRATION_040 = `
  -- Add index for bug lookups
  CREATE INDEX IF NOT EXISTS idx_arms_current_bug ON arms(current_bug_id);
`;

// Migration 041: Add progress column to tasks table for progress visualization
const MIGRATION_041_COLUMNS = [
  { name: 'progress', sql: "ALTER TABLE tasks ADD COLUMN progress INTEGER DEFAULT 0" },
];

const MIGRATION_041 = `
  -- Add index for progress queries
  CREATE INDEX IF NOT EXISTS idx_tasks_progress ON tasks(progress);
`;

// Migration 042: Add task preparation fields for Phase 1.2 Collaborative Planning
const MIGRATION_042_COLUMNS = [
  { name: 'prepared_by_arm_id', sql: "ALTER TABLE tasks ADD COLUMN prepared_by_arm_id TEXT" },
  { name: 'prepared_at', sql: "ALTER TABLE tasks ADD COLUMN prepared_at TEXT" },
];

const MIGRATION_042 = `
  -- Add index for prepared task queries
  CREATE INDEX IF NOT EXISTS idx_tasks_prepared_by ON tasks(prepared_by_arm_id);
  
  -- Add index for prepared tasks (not null = prepared)
  CREATE INDEX IF NOT EXISTS idx_tasks_prepared_at ON tasks(prepared_at);
`;

// Migration 043: Search index for hybrid search
const MIGRATION_043 = `
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
const MIGRATION_044_COLUMNS = [
  { name: "task_id", sql: "ALTER TABLE discoveries ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL" },
  { name: "phase", sql: "ALTER TABLE discoveries ADD COLUMN phase TEXT DEFAULT 'implementation' CHECK (phase IN ('exploration', 'implementation', 'verification'))" },
];

const MIGRATION_044 = `
  -- Ensure discovery rows have a valid phase
  UPDATE discoveries
  SET phase = 'implementation'
  WHERE phase IS NULL OR phase = '';

  -- Restore indexes used by task-scoped discovery lookups
  CREATE INDEX IF NOT EXISTS idx_discoveries_task ON discoveries(task_id);
  CREATE INDEX IF NOT EXISTS idx_discoveries_phase ON discoveries(phase);
`;

// Migration 045: Track total completed task count in brain_state
const MIGRATION_045 = `
  ALTER TABLE brain_state ADD COLUMN completed_task_count INTEGER NOT NULL DEFAULT 0;
`;

// Migration 046: Reduce default arm grace period from 5m to 2m.
// Only updates installations that still use the legacy default value.
const MIGRATION_046 = `
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
const MIGRATION_047_COLUMNS = [
  { name: 'order_key', sql: "ALTER TABLE tasks ADD COLUMN order_key TEXT" },
];

const MIGRATION_047 = `
-- Create index for ordering tasks by their order_key
CREATE INDEX IF NOT EXISTS idx_tasks_order_key ON tasks(order_key);

-- Backfill order_key from existing sort_order using fractional indexing
-- Generate base62 keys: a, b, c, ... za, zb, zc, etc.
WITH ordered_tasks AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (ORDER BY COALESCE(sort_order, 0) ASC, created_at ASC) as row_num,
    COUNT(*) OVER () as total_count
  FROM tasks
  WHERE status IN ('pending', 'claimed', 'in_progress', 'blocked')
),
-- Generate fractional keys for each position
-- Using a simple base62 encoding: position 1 -> 'a', 2 -> 'b', etc.
-- For positions > 62, we use two characters: 'aa', 'ab', etc.
key_mapping AS (
  SELECT 
    id,
    CASE 
      WHEN row_num <= 62 THEN 
        -- Single character: a-z (26), A-Z (26), 0-9 (10) = 62 total
        SUBSTR('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', row_num, 1)
      ELSE
        -- Two characters for larger lists
        SUBSTR('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 
               ((row_num - 1) / 62) + 1, 1) ||
        SUBSTR('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 
               ((row_num - 1) % 62) + 1, 1)
    END as new_order_key
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
const MIGRATION_048_COLUMNS = [
  { name: 'archived', sql: "ALTER TABLE bugs ADD COLUMN archived INTEGER DEFAULT 0" },
];

const MIGRATION_048 = `
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
const MIGRATION_049 = `
DROP TABLE IF EXISTS arm_events;
DELETE FROM config WHERE key = 'arm_events_retention_days';
`;

const MIGRATION_050 = `
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

const MIGRATION_051_COLUMNS = [
  { name: "source", sql: "ALTER TABLE messages ADD COLUMN source TEXT" },
  { name: "stream_name", sql: "ALTER TABLE messages ADD COLUMN stream_name TEXT" },
  { name: "stream_seq", sql: "ALTER TABLE messages ADD COLUMN stream_seq INTEGER" },
  { name: "dedupe_id", sql: "ALTER TABLE messages ADD COLUMN dedupe_id TEXT" },
];

const MIGRATION_051 = `
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

const MIGRATION_052 = `
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

const MIGRATION_053 = `
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

const MIGRATION_054_COLUMNS = [
  {
    name: "workdir",
    sql: "ALTER TABLE arms ADD COLUMN workdir TEXT;",
  },
  {
    name: "last_output_at",
    sql: "ALTER TABLE arms ADD COLUMN last_output_at TEXT;",
  },
];

const MIGRATION_054 = `
CREATE INDEX IF NOT EXISTS idx_arms_workdir ON arms(workdir);
CREATE INDEX IF NOT EXISTS idx_arms_last_output_at ON arms(last_output_at);
`;

const MIGRATION_055 = `
CREATE TABLE IF NOT EXISTS arm_stuck_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arm_id TEXT NOT NULL,
  reason TEXT,
  requested_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at TEXT,
  handled_by TEXT,
  outcome TEXT,
  FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_arm_stuck_requests_arm_id
  ON arm_stuck_requests(arm_id);

CREATE INDEX IF NOT EXISTS idx_arm_stuck_requests_active
  ON arm_stuck_requests(arm_id, handled_at, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_arm_stuck_requests_one_active
  ON arm_stuck_requests(arm_id)
  WHERE handled_at IS NULL;
`;

// Migration 035: Fix sort_order to use ascending order (0 = top, 1 = next, etc.)
// Previously used descending order where higher values appeared first
const MIGRATION_035_FIX_SORT_ORDER = `
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
const MIGRATION_036_COLUMNS = [
  { name: 'sort_order', sql: "ALTER TABLE bugs ADD COLUMN sort_order INTEGER DEFAULT 0" },
  { name: 'metadata', sql: "ALTER TABLE bugs ADD COLUMN metadata TEXT DEFAULT '{}'" },
];

const MIGRATION_036 = `
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
const MIGRATION_037 = `
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
const MIGRATION_038 = `
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
      provider: "opencode",
      model: "gpt-5.1-codex-mini",
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
      model: "gpt-5.1-codex-mini",
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
