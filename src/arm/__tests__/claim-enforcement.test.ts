import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import {
  getClaimMode,
  getClaimEnforcementConfig,
  canWriteToFile,
  autoClaimFile,
  detectThrashing,
  checkAndEscalateIfThrashing,
} from "../claim-enforcement";
import { setEventStore, EventStore } from "../../nats/jetstream";

function setupDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arm_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      released_at TEXT
    );
  `);

  return db;
}

describe("claim-enforcement", () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-claim-enforcement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(testDir, { recursive: true });
    db = setupDb(join(testDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    setEventStore(new EventStore());
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns default claim mode when config missing or invalid", () => {
    expect(getClaimMode(db)).toBe("lazy");

    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ["context_claim_mode", "weird"]);
    expect(getClaimMode(db)).toBe("lazy");

    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ["context_claim_mode", "strict"]);
    expect(getClaimMode(db)).toBe("strict");
  });

  it("builds enforcement config based on mode", () => {
    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ["context_claim_mode", "disabled"]);
    const cfg = getClaimEnforcementConfig(db);
    expect(cfg.mode).toBe("disabled");
    expect(cfg.autoClaimOnWrite).toBe(false);
    expect(cfg.blockOnConflict).toBe(false);
  });

  it("enforces strict and lazy behavior on write checks", () => {
    const armId = "arm-1";
    const filePath = "src/file.ts";

    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ["context_claim_mode", "strict"]);
    const strictNoClaim = canWriteToFile(db, armId, filePath);
    expect(strictNoClaim.canWrite).toBe(false);
    expect(strictNoClaim.shouldClaim).toBe(true);

    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ["context_claim_mode", "lazy"]);
    const lazyNoClaim = canWriteToFile(db, armId, filePath);
    expect(lazyNoClaim.canWrite).toBe(true);
    expect(lazyNoClaim.shouldClaim).toBe(true);

    // Add exclusive claim by another arm
    db.run(
      "INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, datetime('now'))",
      ["arm-2", filePath, "exclusive"]
    );
    const blocked = canWriteToFile(db, armId, filePath);
    expect(blocked.canWrite).toBe(false);
  });

  it("auto-claims file when lazy mode is enabled", () => {
    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ["context_claim_mode", "lazy"]);
    const success = autoClaimFile(db, "arm-1", "src/file.ts");
    expect(success).toBe(true);

    const existing = autoClaimFile(db, "arm-1", "src/file.ts");
    expect(existing).toBe(true);
  });

  it("detects thrashing based on event history", async () => {
    setEventStore({
      publishEvent: async () => {},
      queryEvents: async () => [
        { type: "file_write", armId: "arm-1", data: { filePath: "src/a.ts" }, timestamp: new Date(Date.now() - 2000).toISOString() },
        { type: "file_write", armId: "arm-2", data: { filePath: "src/a.ts" }, timestamp: new Date(Date.now() - 1500).toISOString() },
        { type: "file_write", armId: "arm-1", data: { filePath: "src/a.ts" }, timestamp: new Date(Date.now() - 1000).toISOString() },
        { type: "file_write", armId: "arm-2", data: { filePath: "src/a.ts" }, timestamp: new Date(Date.now() - 500).toISOString() },
      ],
      getArmEvents: async () => [],
      getEventsByType: async () => [],
      getRecentEvents: async () => [],
      isInitialized: () => true,
    });

    const result = await detectThrashing(db, "src/a.ts", 60);
    expect(result.isTrash).toBe(true);
    expect(result.arms.length).toBe(2);
    expect(result.overwriteCount).toBeGreaterThan(0);
  });

  it("skips thrashing checks if disabled or no events", async () => {
    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ["context_claim_mode", "disabled"]);

    await checkAndEscalateIfThrashing(db, "src/a.ts");

    setEventStore({
      publishEvent: async () => {},
      queryEvents: async () => [],
      getArmEvents: async () => [],
      getEventsByType: async () => [],
      getRecentEvents: async () => [],
      isInitialized: () => false,
    });

    const result = await detectThrashing(db, "src/a.ts", 60);
    expect(result.isTrash).toBe(false);
  });
});
