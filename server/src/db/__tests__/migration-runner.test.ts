import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDatabase, openDatabase } from '../index';
import { assertDatabaseCompatible, migrateDatabase, migrationChecksum } from '../migration-runner';
import type { Migration } from '../migration-runner';

const initial: Migration = { name: '001_initial', sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)' };
const additional: Migration = { name: '002_additive', sql: 'ALTER TABLE items ADD COLUMN label TEXT' };
const databases: Database[] = [];
const directories: string[] = [];
const database = () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  databases.push(db);
  return db;
};

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('atomic schema migration and compatibility', () => {
  it('rolls back partial DDL, data, and all pending ledger entries on failure', () => {
    const db = database();
    migrateDatabase(db, [initial]);
    db.run("INSERT INTO items VALUES (1, 'keep')");
    const broken = { name: '003_broken', sql: "UPDATE items SET value = 'lost'; CREATE TABLE partial(id); INSERT INTO missing VALUES (1)" };
    expect(() => migrateDatabase(db, [initial, additional, broken])).toThrow('003_broken failed');
    expect(db.query('SELECT * FROM items').all()).toEqual([{ id: 1, value: 'keep' }]);
    expect(db.query("SELECT name FROM _migrations").all()).toEqual([{ name: initial.name }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'partial'").get()).toBeNull();
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    migrateDatabase(db, [initial, additional]);
    expect(() => assertDatabaseCompatible(db, [initial, additional])).not.toThrow();
  });

  it('does not swallow failed column additions', () => {
    const db = database();
    migrateDatabase(db, [initial]);
    expect(() => migrateDatabase(db, [initial, {
      name: '002_bad_column', sql: 'SELECT 1',
      columns: { table: 'missing', columns: [{ name: 'label', sql: 'ALTER TABLE missing ADD COLUMN label TEXT' }] },
    }])).toThrow('002_bad_column failed');
    expect(db.query('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 1 });
  });

  it('baselines a structurally valid legacy database and detects subsequent checksum changes', () => {
    const db = database();
    db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('001_initial')");
    db.exec(initial.sql);
    expect(() => assertDatabaseCompatible(db, [initial])).toThrow('epoch unknown');
    migrateDatabase(db, [initial]);
    expect(db.query('SELECT checksum FROM _migrations').get()).toEqual({ checksum: migrationChecksum(initial) });
    expect(() => migrateDatabase(db, [{ ...initial, sql: `${initial.sql}; SELECT 1` }])).toThrow('checksum mismatch');
    expect(() => assertDatabaseCompatible(db, [initial])).not.toThrow();
  });

  it('does not bless a legacy migration ledger when required columns are missing', () => {
    const db = database();
    db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('001_initial'); CREATE TABLE items(id INTEGER PRIMARY KEY)");
    expect(() => migrateDatabase(db, [initial])).toThrow('items.value');
    expect(db.query("SELECT name FROM sqlite_master WHERE name = '_schema_compatibility'").get()).toBeNull();
    expect(db.query('PRAGMA table_info(_migrations)').all()).toHaveLength(1);
  });

  it('rejects newer epochs before applying any migration', () => {
    const db = database();
    migrateDatabase(db, [initial]);
    db.run('UPDATE _schema_compatibility SET epoch = 2');
    expect(() => migrateDatabase(db, [initial, additional])).toThrow('epoch 2 is unsupported');
    expect(() => assertDatabaseCompatible(db, [initial])).toThrow('epoch 2 is unsupported');
    expect(db.query('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 1 });
  });

  it('allows newer additive migrations within the same epoch and keeps their records', () => {
    const db = database();
    migrateDatabase(db, [initial, additional]);
    expect(() => assertDatabaseCompatible(db, [initial])).not.toThrow();
    migrateDatabase(db, [initial]);
    expect(db.query('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 2 });
  });

  it('rejects unknown legacy history and missing or altered checksums', () => {
    const db = database();
    db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('999_future')");
    expect(() => migrateDatabase(db, [initial])).toThrow('Unrecognized migration');
    db.exec('DROP TABLE _migrations');
    migrateDatabase(db, [initial]);
    db.run('UPDATE _migrations SET checksum = NULL');
    expect(() => migrateDatabase(db, [initial])).toThrow('checksum mismatch');
  });

  it('rejects pending migrations and structural drift on check-only connections', () => {
    const db = database();
    migrateDatabase(db, [initial]);
    expect(() => assertDatabaseCompatible(db, [initial, additional])).toThrow('migrations are pending');
    db.exec('ALTER TABLE items DROP COLUMN value');
    expect(() => assertDatabaseCompatible(db, [initial])).toThrow('items.value');
  });

  it('rolls back foreign key violations before recording compatibility', () => {
    const db = database();
    expect(() => migrateDatabase(db, [{ name: '001_invalid_fk', sql: `
      CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (7);
    ` }])).toThrow('foreign key violations');
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'parent'").get()).toBeNull();
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('gates existing read-only opens without creating files or migrating them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coleo-db-open-'));
    directories.push(directory);
    const path = join(directory, 'coleo.db');
    expect(() => openDatabase(path)).toThrow();
    expect(await Bun.file(path).exists()).toBe(false);
    const db = await initDatabase(path);
    db.close();
    const readOnly = openDatabase(path, { readonly: true });
    expect(() => readOnly.exec('CREATE TABLE forbidden(id)')).toThrow();
    readOnly.close();
    const writable = openDatabase(path);
    writable.exec('UPDATE _schema_compatibility SET epoch = 999');
    writable.close();
    expect(() => openDatabase(path)).toThrow('epoch 999');
  });

  it('rechecks the migration ledger after waiting for another process to commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coleo-db-lock-'));
    directories.push(directory);
    const path = join(directory, 'coleo.db');
    const db = new Database(path, { create: true });
    databases.push(db);
    db.exec('PRAGMA journal_mode = WAL');
    migrateDatabase(db, [initial]);
    db.exec('BEGIN IMMEDIATE');
    const source = `
      import { Database } from 'bun:sqlite';
      import { migrateDatabase } from ${JSON.stringify(resolve(import.meta.dir, '../migration-runner.ts'))};
      const db = new Database(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 5000');
      console.log('ready');
      migrateDatabase(db, ${JSON.stringify([initial, additional])});
      db.close();
    `;
    const child = Bun.spawn([process.execPath, '-e', source, path], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('ready');
      reader.releaseLock();
      // Child must acquire the parent's lock before it can read the ledger.
      await Bun.sleep(100);
      expect(child.exitCode).toBeNull();
      db.exec(additional.sql);
      db.run('INSERT INTO _migrations (name, checksum) VALUES (?, ?)', [additional.name, migrationChecksum(additional)]);
      db.exec('COMMIT');
      const errors = await new Response(child.stderr).text();
      expect(await child.exited, errors).toBe(0);
      expect(db.query('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 2 });
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      child.kill();
      await child.exited;
    }
  }, 10000);
});

it('upgrades a populated legacy database without cascading away task children', async () => {
  const { getMigrations } = await import('../migration-catalog');
  const directory = await mkdtemp(join(tmpdir(), 'coleo-db-legacy-'));
  directories.push(directory);
  const path = join(directory, 'coleo.db');
  const legacy = new Database(path, { create: true });
  try {
    migrateDatabase(legacy, getMigrations().slice(0, 66));
    legacy.exec(`INSERT INTO tasks (id, subject, description, status, created_at, updated_at)
      VALUES ('parent', 'Keep me', '', 'pending', '2026-01-01', '2026-01-01');
      INSERT INTO task_checklist_items (id, task_id, text, sort_order, created_at, updated_at)
      VALUES (1, 'parent', 'Keep child', 0, '2026-01-01', '2026-01-01');
      DROP TABLE _schema_compatibility;
      ALTER TABLE _migrations DROP COLUMN checksum;`);
  } finally {
    legacy.close();
  }
  const db = await initDatabase(path);
  try {
    expect(db.query("SELECT text FROM task_checklist_items WHERE id = 1").get()).toEqual({ text: 'Keep child' });
    db.exec("UPDATE tasks SET status = 'draft' WHERE id = 'parent'");
    expect(db.query("SELECT subject FROM tasks_fts WHERE tasks_fts MATCH 'keep'").get()).toEqual({ subject: 'Keep me' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('SELECT COUNT(*) AS count FROM _migrations WHERE checksum IS NULL').get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

it('rejects falsely recorded CHECK constraints', () => {
  const db = database();
  const migration = { name: '001_checked', sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, status TEXT CHECK(status IN ('draft', 'pending')))" };
  db.exec("CREATE TABLE _migrations(name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('001_checked'); CREATE TABLE items(id INTEGER PRIMARY KEY, status TEXT CHECK(status IN ('pending')))");
  expect(() => migrateDatabase(db, [migration])).toThrow('CHECK constraint');
});

it('uses the same migration checksums in source and production bundles', async () => {
  const { getMigrations } = await import('../migration-catalog');
  const directory = await mkdtemp(join(tmpdir(), 'coleo-db-bundle-'));
  directories.push(directory);
  const entry = join(directory, 'checksums.ts');
  await Bun.write(entry, `
    import { getMigrations } from ${JSON.stringify(resolve(import.meta.dir, '../migration-catalog.ts'))};
    import { migrationChecksum } from ${JSON.stringify(resolve(import.meta.dir, '../migration-runner.ts'))};
    console.log(JSON.stringify(getMigrations().map(migrationChecksum)));
  `);
  const result = await Bun.build({ entrypoints: [entry], outdir: join(directory, 'dist'), target: 'bun', minify: true });
  expect(result.success).toBe(true);
  const child = Bun.spawn([process.execPath, result.outputs[0]!.path], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  expect(JSON.parse(output)).toEqual(getMigrations().map(migrationChecksum));
});
