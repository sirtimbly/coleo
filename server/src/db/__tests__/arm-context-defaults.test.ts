import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { getMigrations } from "../migration-catalog";
import { assertDatabaseCompatible, migrateDatabase } from "../migration-runner";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function legacyDatabase(contextDefault = "100000", totalDefault = "128000"): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  // Reproduce the schema emitted by older releases, rather than deriving the
  // legacy fixture from today's defaults (which hid the production regression).
  const legacy = getMigrations().slice(0, 68).map((migration) => ({
    ...migration,
    sql: migration.sql
      .replaceAll("context_budget INTEGER NOT NULL DEFAULT 300000", `context_budget INTEGER NOT NULL DEFAULT ${contextDefault}`)
      .replaceAll("context_budget_total INTEGER DEFAULT 300000", `context_budget_total INTEGER DEFAULT ${totalDefault}`),
  }));
  migrateDatabase(db, legacy);
  db.exec("DROP TABLE _schema_compatibility; ALTER TABLE _migrations DROP COLUMN checksum");
  return db;
}

it("upgrades historical arm defaults without changing rows, dependencies, indexes, or triggers", () => {
  const db = legacyDatabase();
  db.exec(`
    ALTER TABLE arms ADD COLUMN future_metadata TEXT;
    INSERT INTO arms (rowid, id, name, domain, harness, context_budget, context_budget_total, future_metadata)
      VALUES (41, 'arm-1', 'Keep arm', 'test', 'opencode', 42000, 64000, 'keep');
    CREATE TABLE arm_dependents (arm_id TEXT REFERENCES arms(id) ON DELETE CASCADE, value TEXT);
    INSERT INTO arm_dependents VALUES ('arm-1', 'keep child');
    CREATE INDEX arms_future_metadata ON arms(future_metadata);
    CREATE TABLE arm_updates (arm_id TEXT);
    CREATE TRIGGER arms_track_update AFTER UPDATE ON arms
      BEGIN INSERT INTO arm_updates VALUES (NEW.id); END;
    CREATE TRIGGER dependent_update AFTER UPDATE ON arm_dependents
      BEGIN UPDATE arms SET name = NEW.value WHERE id = NEW.arm_id; END;
    CREATE VIEW arm_names AS SELECT id, name FROM arms;
  `);
  const before = db.query("SELECT rowid, * FROM arms").all();
  db.exec("PRAGMA legacy_alter_table = OFF");
  migrateDatabase(db, getMigrations());
  expect(db.query("SELECT rowid, * FROM arms").all()).toEqual(before);
  expect(db.query("SELECT * FROM arm_dependents").all()).toEqual([{ arm_id: "arm-1", value: "keep child" }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'arms_future_metadata'").get()).not.toBeNull();
  expect(db.query("SELECT * FROM arm_updates").all()).toEqual([]);
  db.exec("UPDATE arm_dependents SET value = 'updated' WHERE arm_id = 'arm-1'");
  expect(db.query("SELECT name FROM arm_names WHERE id = 'arm-1'").get()).toEqual({ name: "updated" });
  expect(db.query("SELECT * FROM arm_updates").all()).toEqual([{ arm_id: "arm-1" }]);
  db.exec("INSERT INTO arms (id, name, domain, harness) VALUES ('arm-2', 'New arm', 'test', 'opencode')");
  expect(db.query("SELECT context_budget, context_budget_total FROM arms WHERE id = 'arm-2'").get())
    .toEqual({ context_budget: 300000, context_budget_total: 300000 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
  expect(() => assertDatabaseCompatible(db, getMigrations())).not.toThrow();
  const ledger = db.query("SELECT * FROM _migrations").all();
  migrateDatabase(db, getMigrations());
  expect(db.query("SELECT * FROM _migrations").all()).toEqual(ledger);
});

for (const [contextDefault, totalDefault] of [["100000", "300000"], ["300000", "128000"], ["300000", "300000"]]) {
  it(`accepts previously shipped defaults ${contextDefault}/${totalDefault}`, () => {
    const db = legacyDatabase(contextDefault, totalDefault);
    migrateDatabase(db, getMigrations());
    expect(() => assertDatabaseCompatible(db, getMigrations())).not.toThrow();
  });
}

it("rejects unknown defaults without adopting the legacy ledger", () => {
  const db = legacyDatabase("12345");
  const schema = db.query("SELECT sql FROM sqlite_master WHERE name = 'arms'").get();
  expect(() => migrateDatabase(db, getMigrations())).toThrow("unrecognized arms.context_budget definition");
  expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'arms'").get()).toEqual(schema);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = '_schema_compatibility'").get()).toBeNull();
  expect(db.query("SELECT COUNT(*) AS count FROM _migrations").get()).toEqual({ count: 68 });
});

it("rolls back the rebuild if another schema mismatch prevents validation", () => {
  const db = legacyDatabase();
  db.exec("ALTER TABLE arms DROP COLUMN context_budget_used");
  const schema = db.query("SELECT sql FROM sqlite_master WHERE name = 'arms'").get();
  expect(() => migrateDatabase(db, getMigrations())).toThrow("arms.context_budget_used");
  expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'arms'").get()).toEqual(schema);
  expect(db.query("SELECT COUNT(*) AS count FROM _migrations").get()).toEqual({ count: 68 });
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
});
