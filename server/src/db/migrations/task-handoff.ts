/** Durable queue for prepared tasks awaiting Brain eligibility. */
export const MIGRATION_072_TASK_HANDOFF = `
CREATE TABLE IF NOT EXISTS task_handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'activated', 'cancelled')),
  prepared_by TEXT,
  prepared_at TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  activated_at TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_handoffs_status_queued
  ON task_handoffs(status, queued_at);
`;
