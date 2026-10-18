export const MIGRATION_063_ENTITY_STATUS_HISTORY = `
CREATE TABLE IF NOT EXISTS entity_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'bug')),
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, status, changed_at)
);

CREATE INDEX IF NOT EXISTS idx_entity_status_history_type_time
ON entity_status_history(entity_type, changed_at, entity_id);

INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
SELECT 'task', id, 'pending', created_at FROM tasks;

INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
SELECT
  'task',
  id,
  status,
  CASE status
    WHEN 'claimed' THEN COALESCE(claimed_at, updated_at)
    WHEN 'in_progress' THEN COALESCE(started_at, claimed_at, updated_at)
    WHEN 'blocked' THEN COALESCE(blocked_at, updated_at)
    WHEN 'completed' THEN COALESCE(completed_at, updated_at)
    ELSE updated_at
  END
FROM tasks
WHERE status <> 'pending';

INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
SELECT 'bug', id, 'open', created_at FROM bugs;

INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
SELECT
  'bug',
  id,
  status,
  CASE
    WHEN status IN ('resolved', 'closed') THEN COALESCE(resolved_at, updated_at)
    ELSE updated_at
  END
FROM bugs
WHERE status <> 'open';

CREATE TRIGGER IF NOT EXISTS tasks_status_history_insert
AFTER INSERT ON tasks
BEGIN
  INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
  VALUES ('task', NEW.id, NEW.status, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS tasks_status_history_update
AFTER UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status
BEGIN
  INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
  VALUES ('task', NEW.id, NEW.status, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS tasks_status_history_delete
AFTER DELETE ON tasks
BEGIN
  DELETE FROM entity_status_history WHERE entity_type = 'task' AND entity_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS bugs_status_history_insert
AFTER INSERT ON bugs
BEGIN
  INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
  VALUES ('bug', NEW.id, NEW.status, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS bugs_status_history_update
AFTER UPDATE OF status ON bugs
WHEN OLD.status <> NEW.status
BEGIN
  INSERT OR IGNORE INTO entity_status_history (entity_type, entity_id, status, changed_at)
  VALUES ('bug', NEW.id, NEW.status, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS bugs_status_history_delete
AFTER DELETE ON bugs
BEGIN
  DELETE FROM entity_status_history WHERE entity_type = 'bug' AND entity_id = OLD.id;
END;
`;

export const MIGRATION_064_COLUMNS = [
  {
    name: "planning_blocked",
    sql: "ALTER TABLE arms ADD COLUMN planning_blocked INTEGER NOT NULL DEFAULT 0;",
  },
];

export const MIGRATION_065_WORKBENCH_PROFILES = `
-- Portable user-facing workbench identities. Authentication remains API-key
-- based for now, while profile IDs make saved UI state account-ready.
CREATE TABLE IF NOT EXISTS workbench_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workbench_profiles_email
ON workbench_profiles(email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workbench_profiles_default
ON workbench_profiles(is_default) WHERE is_default = 1;

INSERT OR IGNORE INTO workbench_profiles (
  id, name, is_default, preferences, created_at, updated_at
) VALUES (
  'local', 'Local workspace', 1, '{}', datetime('now'), datetime('now')
);

-- A saved projection and all of its presentation preferences. The query and
-- preferences remain JSON because each projection type has a different schema.
CREATE TABLE IF NOT EXISTS workbench_views (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  view_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'sheet', 'inbox', 'timeline', 'conversation', 'process',
    'document', 'dashboard', 'inspector'
  )),
  resource_kind TEXT,
  query TEXT NOT NULL DEFAULT '{}',
  preferences TEXT NOT NULL DEFAULT '{}',
  shared INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES workbench_profiles(id) ON DELETE CASCADE,
  UNIQUE(profile_id, view_key)
);

CREATE INDEX IF NOT EXISTS idx_workbench_views_profile
ON workbench_views(profile_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbench_views_shared
ON workbench_views(shared, updated_at DESC);

-- Golden Layout configuration is stored separately from saved view definitions
-- so one view may appear in multiple named workspaces.
CREATE TABLE IF NOT EXISTS workbench_layouts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  layout TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  shared INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES workbench_profiles(id) ON DELETE CASCADE,
  UNIQUE(profile_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workbench_layouts_profile
ON workbench_layouts(profile_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbench_layouts_shared
ON workbench_layouts(shared, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workbench_layouts_profile_default
ON workbench_layouts(profile_id) WHERE is_default = 1;

-- Per-profile attention state is deliberately separate from immutable events.
CREATE TABLE IF NOT EXISTS workbench_attention (
  profile_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  seen_at TEXT,
  read_at TEXT,
  archived_at TEXT,
  snoozed_until TEXT,
  resolved_at TEXT,
  assigned_to TEXT,
  requires_action INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, item_key),
  FOREIGN KEY (profile_id) REFERENCES workbench_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workbench_attention_profile_action
ON workbench_attention(profile_id, requires_action, updated_at DESC);
`;

export const MIGRATION_066_ARM_RUNS = `
-- Runs are attempts made by Arms, not user-created jobs. A run begins when an
-- Arm claims work and remains active while that work is running or blocked.
CREATE TABLE IF NOT EXISTS arm_runs (
  id TEXT PRIMARY KEY,
  arm_id TEXT NOT NULL,
  work_kind TEXT NOT NULL CHECK (work_kind IN ('task', 'bug')),
  work_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'claimed', 'running', 'blocked', 'completed', 'failed', 'cancelled'
  )),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_arm_runs_active_work
ON arm_runs(work_kind, work_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_arm_runs_arm_time
ON arm_runs(arm_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_arm_runs_status_time
ON arm_runs(status, started_at DESC);

-- Backfill one current run for work already claimed when this migration lands.
INSERT OR IGNORE INTO arm_runs (
  id, arm_id, work_kind, work_id, status, started_at, ended_at, metadata
)
SELECT
  lower(hex(randomblob(16))),
  assigned_to,
  'task',
  id,
  CASE
    WHEN status = 'claimed' THEN 'claimed'
    WHEN status = 'blocked' THEN 'blocked'
    ELSE 'running'
  END,
  COALESCE(started_at, claimed_at, updated_at),
  NULL,
  '{"inferred":true}'
FROM tasks
WHERE assigned_to IS NOT NULL
  AND status IN ('claimed', 'in_progress', 'completing', 'blocked');

INSERT OR IGNORE INTO arm_runs (
  id, arm_id, work_kind, work_id, status, started_at, ended_at, metadata
)
SELECT
  lower(hex(randomblob(16))),
  assignee_arm_id,
  'bug',
  id,
  CASE WHEN status = 'investigating' THEN 'claimed' ELSE 'running' END,
  updated_at,
  NULL,
  '{"inferred":true}'
FROM bugs
WHERE assignee_arm_id IS NOT NULL
  AND status IN ('investigating', 'fixing', 'verifying')
  AND COALESCE(archived, 0) = 0;

CREATE TRIGGER IF NOT EXISTS task_run_after_insert
AFTER INSERT ON tasks
WHEN NEW.assigned_to IS NOT NULL
  AND NEW.status IN ('claimed', 'in_progress', 'completing', 'blocked')
BEGIN
  INSERT OR IGNORE INTO arm_runs (
    id, arm_id, work_kind, work_id, status, started_at, metadata
  ) VALUES (
    lower(hex(randomblob(16))),
    NEW.assigned_to,
    'task',
    NEW.id,
    CASE
      WHEN NEW.status = 'claimed' THEN 'claimed'
      WHEN NEW.status = 'blocked' THEN 'blocked'
      ELSE 'running'
    END,
    COALESCE(NEW.started_at, NEW.claimed_at, NEW.updated_at),
    '{}'
  );
END;

CREATE TRIGGER IF NOT EXISTS task_run_after_update
AFTER UPDATE OF status, assigned_to ON tasks
BEGIN
  UPDATE arm_runs
  SET
    status = CASE
      WHEN NEW.assigned_to IS NULL OR arm_id <> NEW.assigned_to THEN 'cancelled'
      WHEN NEW.status = 'claimed' THEN 'claimed'
      WHEN NEW.status IN ('in_progress', 'completing') THEN 'running'
      WHEN NEW.status = 'blocked' THEN 'blocked'
      WHEN NEW.status = 'completed' THEN 'completed'
      WHEN NEW.status = 'failed' THEN 'failed'
      WHEN NEW.status = 'cancelled' THEN 'cancelled'
      ELSE 'cancelled'
    END,
    ended_at = CASE
      WHEN NEW.assigned_to IS NULL OR arm_id <> NEW.assigned_to
        OR NEW.status NOT IN ('claimed', 'in_progress', 'completing', 'blocked')
      THEN NEW.updated_at
      ELSE ended_at
    END
  WHERE work_kind = 'task' AND work_id = NEW.id AND ended_at IS NULL;

  INSERT OR IGNORE INTO arm_runs (
    id, arm_id, work_kind, work_id, status, started_at, metadata
  )
  SELECT
    lower(hex(randomblob(16))),
    NEW.assigned_to,
    'task',
    NEW.id,
    CASE
      WHEN NEW.status = 'claimed' THEN 'claimed'
      WHEN NEW.status = 'blocked' THEN 'blocked'
      ELSE 'running'
    END,
    COALESCE(NEW.started_at, NEW.claimed_at, NEW.updated_at),
    '{}'
  WHERE NEW.assigned_to IS NOT NULL
    AND NEW.status IN ('claimed', 'in_progress', 'completing', 'blocked')
    AND NOT EXISTS (
      SELECT 1 FROM arm_runs
      WHERE work_kind = 'task' AND work_id = NEW.id AND ended_at IS NULL
    );
END;

CREATE TRIGGER IF NOT EXISTS bug_run_after_insert
AFTER INSERT ON bugs
WHEN NEW.assignee_arm_id IS NOT NULL
  AND NEW.status IN ('investigating', 'fixing', 'verifying')
BEGIN
  INSERT OR IGNORE INTO arm_runs (
    id, arm_id, work_kind, work_id, status, started_at, metadata
  ) VALUES (
    lower(hex(randomblob(16))),
    NEW.assignee_arm_id,
    'bug',
    NEW.id,
    CASE WHEN NEW.status = 'investigating' THEN 'claimed' ELSE 'running' END,
    NEW.updated_at,
    '{}'
  );
END;

CREATE TRIGGER IF NOT EXISTS bug_run_after_update
AFTER UPDATE OF status, assignee_arm_id, archived ON bugs
BEGIN
  UPDATE arm_runs
  SET
    status = CASE
      WHEN NEW.assignee_arm_id IS NULL OR arm_id <> NEW.assignee_arm_id
        OR COALESCE(NEW.archived, 0) = 1 THEN 'cancelled'
      WHEN NEW.status = 'investigating' THEN 'claimed'
      WHEN NEW.status IN ('fixing', 'verifying') THEN 'running'
      WHEN NEW.status IN ('resolved', 'closed') THEN 'completed'
      ELSE 'cancelled'
    END,
    ended_at = CASE
      WHEN NEW.assignee_arm_id IS NULL OR arm_id <> NEW.assignee_arm_id
        OR COALESCE(NEW.archived, 0) = 1
        OR NEW.status NOT IN ('investigating', 'fixing', 'verifying')
      THEN NEW.updated_at
      ELSE ended_at
    END
  WHERE work_kind = 'bug' AND work_id = NEW.id AND ended_at IS NULL;

  INSERT OR IGNORE INTO arm_runs (
    id, arm_id, work_kind, work_id, status, started_at, metadata
  )
  SELECT
    lower(hex(randomblob(16))),
    NEW.assignee_arm_id,
    'bug',
    NEW.id,
    CASE WHEN NEW.status = 'investigating' THEN 'claimed' ELSE 'running' END,
    NEW.updated_at,
    '{}'
  WHERE NEW.assignee_arm_id IS NOT NULL
    AND NEW.status IN ('investigating', 'fixing', 'verifying')
    AND COALESCE(NEW.archived, 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM arm_runs
      WHERE work_kind = 'bug' AND work_id = NEW.id AND ended_at IS NULL
    );
END;
`;

// Migration 067 is implemented by addDraftTaskStatus because SQLite requires a
// table rebuild to change a CHECK constraint while preserving later columns,
// indexes, triggers, dependent rows, and external-content FTS rowids.
export const MIGRATION_067_TASK_DRAFT_STATUS = "SELECT 1;";

export const MIGRATION_068_WORKBENCH_CARD_INSTANCES = `
CREATE TABLE IF NOT EXISTS workbench_card_instances (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  resource_kind TEXT,
  resource_id TEXT,
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES workbench_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workbench_card_instances_resource
ON workbench_card_instances(profile_id, resource_kind, resource_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workbench_card_action_receipts (
  client_action_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  resource_kind TEXT,
  resource_id TEXT,
  verb TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_card_action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_action_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  resource_kind TEXT,
  resource_id TEXT,
  verb TEXT NOT NULL,
  input_keys TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workbench_card_action_audit_resource
ON workbench_card_action_audit(resource_kind, resource_id, created_at DESC);
`;

