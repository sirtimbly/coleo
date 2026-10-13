export const MIGRATION_071_SWARM_RECOMMENDATIONS = `
CREATE TABLE brain_swarm_recommendations (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES brain_swarm_evaluations(id),
  proposal TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'recommended',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_swarm_recommendations_created ON brain_swarm_recommendations(created_at, id);
`;
