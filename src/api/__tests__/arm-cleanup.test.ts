import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { HarnessManager } from "../../harness";
import { cleanupOrphanedArms } from "../arm-cleanup";

interface ArmRow {
	id: string;
	status: string;
	pid: number | null;
	port: number | null;
}

describe("cleanupOrphanedArms", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
      CREATE TABLE arms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pid INTEGER,
        port INTEGER,
        harness TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
	});

	afterEach(() => {
		db.close();
	});

	it("marks alive but unrecoverable arms as stopped", async () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, name, pid, port, harness, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["arm-1", "arm-1", process.pid, null, "opencode-tui", "idle", now],
		);

		await cleanupOrphanedArms(db);

		const arm = db
			.query("SELECT id, status, pid, port FROM arms WHERE id = ?")
			.get("arm-1") as ArmRow | null;
		expect(arm).not.toBeNull();
		expect(arm?.status).toBe("stopped");
		expect(arm?.pid).toBeNull();
		expect(arm?.port).toBeNull();
	});

	it("keeps arm running when recovery succeeds", async () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, name, pid, port, harness, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["arm-2", "arm-2", process.pid, 12345, "opencode-api", "idle", now],
		);

		const mockHarnessManager = {
			recover: async () => true,
		} as unknown as HarnessManager;

		await cleanupOrphanedArms(db, mockHarnessManager);

		const arm = db
			.query("SELECT id, status, pid, port FROM arms WHERE id = ?")
			.get("arm-2") as ArmRow | null;
		expect(arm).not.toBeNull();
		expect(arm?.status).toBe("idle");
		expect(arm?.pid).toBe(process.pid);
		expect(arm?.port).toBe(12345);
	});
});
