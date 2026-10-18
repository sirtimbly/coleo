export const MIGRATION_070_SWARM_EVALUATIONS = `
CREATE TABLE brain_swarm_actions (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','executing','succeeded','uncertain','rejected')),
  proposal TEXT NOT NULL,
  evidence_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_brain_swarm_actions_scope ON brain_swarm_actions(scope_key, updated_at);
CREATE TABLE brain_swarm_evaluations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  result TEXT NOT NULL
);
`;
