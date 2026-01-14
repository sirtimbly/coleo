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

  // Define migrations in order
  const migrations: [string, string][] = [
    ["001_initial_schema", MIGRATION_001],
    ["002_add_proposals", MIGRATION_002],
    ["003_add_claims", MIGRATION_003],
    ["004_arm_personality", MIGRATION_004],
    ["005_tick_based_timeouts", MIGRATION_005],
    ["006_arm_spawn_fields", MIGRATION_006],
    ["007_fix_status_constraint", MIGRATION_007],
    ["008_arm_heartbeat", MIGRATION_008],
  ];

  // Apply pending migrations
  for (const [name, sql] of migrations) {
    if (applied.has(name)) continue;

    console.log(`Applying migration: ${name}`);
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

export { Database };
