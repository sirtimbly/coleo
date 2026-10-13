import type { Database } from "bun:sqlite";

/** Normalize defaults shipped before schema checksums, without changing arm budgets. */
export function normalizeArmContextDefaults(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'arms'")
    .get() as { sql: string } | null;
  if (!table) throw new Error("Cannot normalize context defaults because the arms table is missing");

  const columns = db.query("PRAGMA table_info(arms)").all() as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null;
  }>;
  let replacementSql = table.sql;
  for (const [name, legacyDefault, notnull] of [
    ["context_budget", "100000", 1],
    ["context_budget_total", "128000", 0],
  ] as const) {
    const column = columns.find((column) => column.name === name);
    if (!column || column.type.toUpperCase() !== "INTEGER" || column.notnull !== notnull
      || ![legacyDefault, "300000"].includes(column.dflt_value ?? "")) {
      throw new Error(`Cannot safely normalize unrecognized arms.${name} definition`);
    }
    if (column.dflt_value === "300000") continue;
    const definition = new RegExp(
      `(\\b${name}\\s+INTEGER\\s+${notnull ? "NOT\\s+NULL\\s+" : ""}DEFAULT\\s+)${legacyDefault}\\b`, "i",
    );
    if (!definition.test(replacementSql)) {
      throw new Error(`Cannot safely normalize unrecognized arms.${name} SQL`);
    }
    replacementSql = replacementSql.replace(definition, (_match, prefix: string) => `${prefix}300000`);
  }
  if (replacementSql === table.sql) return;

  const schemaObjects = db.query(`SELECT sql FROM sqlite_master
    WHERE tbl_name = 'arms' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name`).all() as Array<{ sql: string }>;
  replacementSql = replacementSql.replace(
    /^CREATE TABLE\s+(?:"arms"|arms)\s*/i, "CREATE TABLE arms_context_defaults_migration ",
  );
  if (!replacementSql.startsWith("CREATE TABLE arms_context_defaults_migration ")) {
    throw new Error("Cannot safely rebuild unrecognized arms table SQL");
  }
  // The migration runner disables foreign keys and wraps this rebuild in its transaction.
  // Preserve additive columns and rowids as well as every existing context budget.
  const columnList = columns.map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(", ");
  db.exec(replacementSql);
  db.exec(`INSERT INTO arms_context_defaults_migration (rowid, ${columnList})
    SELECT rowid, ${columnList} FROM arms`);
  db.exec("DROP TABLE arms");
  // Other tables' triggers can reference arms while it is temporarily absent.
  const { legacy_alter_table: legacyAlterTable } = db.query("PRAGMA legacy_alter_table").get() as {
    legacy_alter_table: number;
  };
  try {
    db.exec("PRAGMA legacy_alter_table = ON");
    db.exec("ALTER TABLE arms_context_defaults_migration RENAME TO arms");
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacyAlterTable ? "ON" : "OFF"}`);
  }
  for (const { sql } of schemaObjects) db.exec(sql);
}
