import type { Database } from "bun:sqlite";

export function addDraftTaskStatus(db: Database): void {
  const table = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get() as { sql: string } | null;
  if (!table) throw new Error("Cannot add Draft status because the tasks table is missing");

  const legacyConstraint =
    "CHECK (status IN ('pending', 'claimed', 'in_progress', 'completing', 'completed', 'failed', 'blocked', 'cancelled'))";
  const draftConstraint =
    "CHECK (status IN ('draft', 'pending', 'claimed', 'in_progress', 'completing', 'completed', 'failed', 'blocked', 'cancelled'))";
  if (table.sql.includes(draftConstraint)) return;
  if (!table.sql.includes(legacyConstraint)) {
    throw new Error("Cannot safely add Draft status because the tasks status constraint is unrecognized");
  }

  const schemaObjects = db
    .query(
      `SELECT type, name, sql
       FROM sqlite_master
       WHERE tbl_name = 'tasks'
         AND type IN ('index', 'trigger')
         AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all() as Array<{ type: "index" | "trigger"; name: string; sql: string }>;
  const columns = (
    db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
  ).map(({ name }) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Cannot safely migrate unexpected task column: ${name}`);
    }
    return `"${name}"`;
  });
  const replacementSql = table.sql
    .replace(
      /^CREATE TABLE\s+(?:"tasks"|tasks)\s*/i,
      "CREATE TABLE tasks_draft_migration ",
    )
    .replace(legacyConstraint, draftConstraint);
  db.exec("DROP TABLE IF EXISTS tasks_draft_migration");
  db.exec(replacementSql);
  const columnList = columns.join(", ");
  db.exec(
    `INSERT INTO tasks_draft_migration (rowid, ${columnList})
     SELECT rowid, ${columnList} FROM tasks`,
  );
  db.exec("DROP TABLE tasks");
  db.exec("ALTER TABLE tasks_draft_migration RENAME TO tasks");
  for (const schemaObject of schemaObjects) db.exec(schemaObject.sql);
}
