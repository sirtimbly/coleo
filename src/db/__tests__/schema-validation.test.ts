import { Database } from 'bun:sqlite';
import { afterEach, expect, it } from 'bun:test';
import { assertDatabaseCompatible, migrateDatabase } from '../migration-runner';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const tables = `CREATE TABLE parents(a INTEGER, b INTEGER, UNIQUE(a,b));
  CREATE TABLE items(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, value TEXT,
    UNIQUE(value), FOREIGN KEY(a,b) REFERENCES parents(a,b) ON DELETE CASCADE);`;
const objects = `CREATE UNIQUE INDEX items_lookup ON items(a, b) WHERE value IS NOT NULL;
  CREATE TRIGGER items_update AFTER UPDATE ON items BEGIN UPDATE items SET value = 'Ready  now' WHERE id = NEW.id; END;
  CREATE VIEW items_view AS SELECT id, value FROM items;`;
const migration = { name: '001_schema', sql: tables + objects };

function legacy(sql: string): Database {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE _migrations(name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('001_schema'); ${sql}`);
  db.exec("INSERT INTO items VALUES (1, NULL, NULL, 'keep')");
  return db;
}

for (const [name, original, replacement, error] of [
  ['index columns', 'items(a, b)', 'items(b, a)', 'index items_lookup'],
  ['index uniqueness', 'CREATE UNIQUE INDEX', 'CREATE INDEX', 'index items_lookup'],
  ['index predicate', 'WHERE value IS NOT NULL', 'WHERE value IS NULL', 'index items_lookup'],
  ['index collation', 'items(a, b)', 'items(a COLLATE NOCASE, b)', 'index items_lookup'],
  ['trigger body', "'Ready  now'", "'ready now'", 'trigger items_update'],
  ['view projection', 'SELECT id, value', 'SELECT id, a AS value', 'view items_view'],
  ['missing foreign key', ', FOREIGN KEY(a,b) REFERENCES parents(a,b) ON DELETE CASCADE', '', 'foreign key on items'],
  ['foreign key action', 'ON DELETE CASCADE', 'ON DELETE RESTRICT', 'foreign key on items'],
  ['composite foreign key order', 'REFERENCES parents(a,b)', 'REFERENCES parents(b,a)', 'foreign key on items'],
  ['table uniqueness', 'UNIQUE(value), ', '', 'unique key on items'],
]) {
  it(`rejects altered ${name} before baselining and rolls back metadata`, () => {
    const db = legacy(migration.sql.replace(original!, replacement!));
    expect(() => migrateDatabase(db, [migration])).toThrow(error!);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = '_schema_compatibility'").get()).toBeNull();
    expect(db.query('PRAGMA table_info(_migrations)').all()).toHaveLength(1);
    expect(db.query('SELECT value FROM items WHERE id = 1').get()).toEqual({ value: 'keep' });
  });
}

it('accepts harmless formatting, comments, quoted identifiers, and additive columns', () => {
  const db = legacy((tables + objects).replace('ON items(a, b)', 'on "items" ( a , /* index keys */ b )'));
  db.exec('ALTER TABLE items ADD COLUMN extra TEXT');
  migrateDatabase(db, [migration]);
  expect(() => assertDatabaseCompatible(db, [migration])).not.toThrow();
});

it('detects definition drift on check-only opens without changing metadata', () => {
  const db = legacy(migration.sql);
  migrateDatabase(db, [migration]);
  const ledger = db.query('SELECT * FROM _migrations').all();
  db.exec('DROP VIEW items_view; CREATE VIEW items_view AS SELECT id, a AS value FROM items');
  expect(() => assertDatabaseCompatible(db, [migration])).toThrow('view items_view');
  expect(db.query('SELECT * FROM _migrations').all()).toEqual(ledger);
});
