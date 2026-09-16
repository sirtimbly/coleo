/** Database entry points. Explicit initialization migrates; direct opens only validate. */
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import { getMigrations } from "./migration-catalog";
import { migrateDatabase, assertDatabaseCompatible } from "./migration-runner";

export { Database };
export { seedDatabase } from "./seed";

export async function initDatabase(dbPath: string): Promise<Database> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrateDatabase(db, getMigrations());
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", ["database_instance_id", randomUUID()]);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Open an existing database without migrating it or creating an empty file. */
export function openDatabase(dbPath: string, options: { readonly?: boolean } = {}): Database {
  const db = new Database(dbPath, options.readonly ? { readonly: true } : { readwrite: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // Read a consistent snapshot of metadata and schema during concurrent startup.
    db.transaction(() => assertDatabaseCompatible(db, getMigrations()))();
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
