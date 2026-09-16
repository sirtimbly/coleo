import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { schemaDefinition, tableStructure, type TableStructure } from './schema-structure';

/** Increment only when old database clients can no longer read/write safely. */
export const DATABASE_COMPATIBILITY_EPOCH = 1;
export const MINIMUM_MIGRATABLE_EPOCH = 1;

export interface Migration {
  name: string;
  sql: string;
  columns?: { table: string; columns: Array<{ name: string; sql: string }> };
  apply?: (db: Database) => void;
  /** Stable across source and bundled execution; change when callback behavior changes. */
  implementationVersion?: string;
}

interface AppliedMigration {
  name: string;
  checksum: string | null;
}

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface RequiredSchema {
  objects: SchemaObject[];
  columns: Map<string, Column[]>;
  structures: Map<string, TableStructure>;
}

const requiredSchemas = new Map<string, RequiredSchema>();

export class DatabaseCompatibilityError extends Error {
  constructor(message: string) {
    super(`${message}. Start the matching Coleo API release to migrate, or restore a compatible backup; do not edit migration records.`);
    this.name = 'DatabaseCompatibilityError';
  }
}

export function migrationChecksum(migration: Migration): string {
  if (migration.apply && !migration.implementationVersion) {
    throw new Error(`Migration ${migration.name} requires an implementationVersion for its callback`);
  }
  return createHash('sha256').update(JSON.stringify({
    name: migration.name,
    sql: migration.sql,
    columns: migration.columns ?? null,
    implementationVersion: migration.implementationVersion ?? null,
  })).digest('hex');
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function columnsFor(db: Database, table: string): Column[] {
  return db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Column[];
}

function applyMigration(db: Database, migration: Migration): void {
  if (migration.columns) {
    for (const column of migration.columns.columns) {
      if (!columnsFor(db, migration.columns.table).some((existing) => existing.name === column.name)) {
        db.exec(column.sql);
      }
    }
  }
  if (migration.apply) migration.apply(db);
  else db.exec(migration.sql);
}

function getRequiredSchema(migrations: readonly Migration[]): RequiredSchema {
  const key = migrations.map(migrationChecksum).join(':');
  const cached = requiredSchemas.get(key);
  if (cached) return cached;
  // Derive the minimum structure from this release's own migrations, never the live database.
  const reference = new Database(':memory:');
  try {
    reference.exec('PRAGMA foreign_keys = OFF');
    reference.transaction(() => {
      for (const migration of migrations) applyMigration(reference, migration);
    })();
    const objects = reference.query(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')`).all() as SchemaObject[];
    const schema = {
      objects,
      structures: new Map(objects.filter((object) => object.type === 'table')
        .map((object) => [object.name, tableStructure(reference, object.name)])),
      columns: new Map(objects.filter((object) => object.type === 'table')
        .map((object) => [object.name, columnsFor(reference, object.name)])),
    };
    requiredSchemas.set(key, schema);
    return schema;
  } finally {
    reference.close();
  }
}

function checkConstraints(sql: string): string[] {
  const checks: string[] = [];
  const pattern = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    let depth = 1;
    let quote = '';
    let end = pattern.lastIndex;
    for (; end < sql.length && depth; end++) {
      const char = sql[end]!;
      if (quote) {
        if (char === quote) {
          if (sql[end + 1] === quote) end++;
          else quote = '';
        }
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
    }
    checks.push(sql.slice(pattern.lastIndex, end - 1).replace(/\s+/g, ' ').trim());
    pattern.lastIndex = end;
  }
  return checks;
}

function validateRequiredSchema(db: Database, migrations: readonly Migration[]): void {
  const required = getRequiredSchema(migrations);
  for (const object of required.objects) {
    const actual = db.query('SELECT sql FROM sqlite_master WHERE type = ? AND name = ? AND tbl_name = ?')
      .get(object.type, object.name, object.tbl_name) as { sql: string | null } | null;
    if (!actual) {
      throw new DatabaseCompatibilityError(`Required ${object.type} ${object.name} is missing`);
    }
    if (object.type !== 'table' && schemaDefinition(actual.sql) !== schemaDefinition(object.sql)) {
      throw new DatabaseCompatibilityError(`Required ${object.type} ${object.name} has an incompatible definition`);
    }
    if (object.type === 'table') {
      const expected = required.structures.get(object.name)!;
      const structure = tableStructure(db, object.name);
      if (expected.foreignKeys.some((key) => !structure.foreignKeys.includes(key))) {
        throw new DatabaseCompatibilityError(`Required foreign key on ${object.name} is missing or incompatible`);
      }
      if (expected.uniqueKeys.some((key) => !structure.uniqueKeys.includes(key))) {
        throw new DatabaseCompatibilityError(`Required unique key on ${object.name} is missing or incompatible`);
      }
      const checks = checkConstraints(actual.sql ?? '');
      if (checkConstraints(object.sql ?? '').some((check) => !checks.includes(check))) {
        throw new DatabaseCompatibilityError(`Required CHECK constraint on ${object.name} is missing or incompatible`);
      }
    }
  }
  for (const [table, columns] of required.columns) {
    const actual = new Map(columnsFor(db, table).map((column) => [column.name, column]));
    for (const expected of columns) {
      const column = actual.get(expected.name);
      if (!column || column.type.toUpperCase() !== expected.type.toUpperCase()
        || column.pk !== expected.pk || column.notnull !== expected.notnull
        || column.dflt_value !== expected.dflt_value) {
        throw new DatabaseCompatibilityError(`Required column ${table}.${expected.name} is missing or incompatible`);
      }
    }
  }
}

function readEpoch(db: Database): number | null {
  if (!hasTable(db, '_schema_compatibility')) return null;
  const row = db.query('SELECT epoch FROM _schema_compatibility WHERE id = 1').get() as { epoch: number } | null;
  if (!row || !Number.isSafeInteger(row.epoch) || row.epoch < 1) {
    throw new DatabaseCompatibilityError('Database compatibility metadata is invalid');
  }
  return row.epoch;
}

function readApplied(db: Database): AppliedMigration[] {
  if (!hasTable(db, '_migrations')) return [];
  const hasChecksum = columnsFor(db, '_migrations').some((column) => column.name === 'checksum');
  return db.query(`SELECT name, ${hasChecksum ? 'checksum' : 'NULL AS checksum'} FROM _migrations`).all() as AppliedMigration[];
}

function validateHistory(db: Database, migrations: readonly Migration[], allowLegacy: boolean): Set<string> {
  const epoch = readEpoch(db);
  if (epoch !== DATABASE_COMPATIBILITY_EPOCH && !(allowLegacy && (epoch === null || (epoch >= MINIMUM_MIGRATABLE_EPOCH && epoch < DATABASE_COMPATIBILITY_EPOCH)))) {
    throw new DatabaseCompatibilityError(`Database epoch ${epoch ?? 'unknown'} is unsupported; expected ${DATABASE_COMPATIBILITY_EPOCH}`);
  }
  const known = new Map(migrations.map((migration) => [migration.name, migrationChecksum(migration)]));
  const applied = readApplied(db);
  for (const row of applied) {
    const checksum = known.get(row.name);
    if (!checksum) {
      // Forward additive migrations are allowed only when the newer release explicitly declares our epoch.
      if (epoch !== DATABASE_COMPATIBILITY_EPOCH || !row.checksum || !/^[a-f0-9]{64}$/.test(row.checksum)) {
        throw new DatabaseCompatibilityError(`Unrecognized migration ${row.name} has no trusted compatibility metadata`);
      }
    } else if (row.checksum !== checksum && !(allowLegacy && epoch === null && row.checksum === null)) {
      throw new DatabaseCompatibilityError(`Migration checksum mismatch for ${row.name}`);
    }
  }
  return new Set(applied.map((row) => row.name));
}

/** Check-only: direct clients must never independently migrate the shared database. */
export function assertDatabaseCompatible(db: Database, migrations: readonly Migration[]): void {
  const applied = validateHistory(db, migrations, false);
  const pending = migrations.filter((migration) => !applied.has(migration.name));
  if (pending.length) throw new DatabaseCompatibilityError(`${pending.length} database migrations are pending (${pending[0]!.name})`);
  validateRequiredSchema(db, migrations);
}

/** Serialize the full upgrade and commit schema changes plus ledger entries together. */
export function migrateDatabase(db: Database, migrations: readonly Migration[]): void {
  if (db.inTransaction) throw new Error('Database migrations require a connection outside a transaction');
  if (new Set(migrations.map((migration) => migration.name)).size !== migrations.length) {
    throw new Error('Duplicate migration names');
  }
  const foreignKeys = (db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  // SQLite ignores changes to foreign_keys inside a transaction. Table rebuilds need it off first.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      // All reads of migration state happen AFTER acquiring SQLite's write lock.
      const applied = validateHistory(db, migrations, true);
      db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')), checksum TEXT
      )`);
      if (!columnsFor(db, '_migrations').some((column) => column.name === 'checksum')) {
        db.exec('ALTER TABLE _migrations ADD COLUMN checksum TEXT');
      }
      for (const migration of migrations) {
        if (!applied.has(migration.name)) {
          try {
            applyMigration(db, migration);
            db.run('INSERT INTO _migrations (name, checksum) VALUES (?, ?)', [migration.name, migrationChecksum(migration)]);
          } catch (cause) {
            throw new Error(`Database migration ${migration.name} failed; upgrade rolled back: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
          }
        }
      }
      validateRequiredSchema(db, migrations);
      const violations = db.query('PRAGMA foreign_key_check').all();
      if (violations.length) throw new DatabaseCompatibilityError(`Database has ${violations.length} foreign key violations`);
      // Legacy adoption is a baseline of this release after structural validation, not proof of past SQL.
      for (const migration of migrations) {
        db.run('UPDATE _migrations SET checksum = ? WHERE name = ? AND checksum IS NULL', [migrationChecksum(migration), migration.name]);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS _schema_compatibility (
        id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL CHECK (epoch > 0)
      )`);
      db.run('INSERT INTO _schema_compatibility (id, epoch) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch', [DATABASE_COMPATIBILITY_EPOCH]);
    }).immediate();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY') {
      throw new Error('Database migration lock timed out. Another process holds the SQLite write lock; retry startup after it finishes.', { cause: error });
    }
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}
