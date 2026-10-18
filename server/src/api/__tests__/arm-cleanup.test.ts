import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { HarnessManager } from "../../harness";
import { cleanupOrphanedArms } from "../arm-cleanup";

interface ArmRow {
	id: string;
	status: string;
	pid: number | null;
	port: number | null;
	agent_id: string | null;
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
        agent_id TEXT,
        harness TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arm_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        released_at TEXT
      );
    `);
	});

	afterEach(() => {
		db.close();
	});

	it("keeps alive but unrecoverable local arms in current state", async () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, name, pid, port, agent_id, harness, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["arm-1", "arm-1", process.pid, null, null, "opencode-tui", "idle", now],
		);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-1", "src/example.ts", "write", now],
		);

		await cleanupOrphanedArms(db);

		const arm = db
			.query("SELECT id, status, pid, port FROM arms WHERE id = ?")
			.get("arm-1") as ArmRow | null;
		expect(arm).not.toBeNull();
		expect(arm?.status).toBe("idle");
		expect(arm?.pid).toBe(process.pid);
		expect(arm?.port).toBeNull();

		const claim = db
			.query("SELECT released_at FROM claims WHERE arm_id = ? AND file_path = ?")
			.get("arm-1", "src/example.ts") as { released_at: string | null } | null;
		expect(claim).not.toBeNull();
		expect(claim?.released_at).toBeNull();
	});

	it("keeps arm running when recovery succeeds", async () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, name, pid, port, agent_id, harness, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["arm-2", "arm-2", process.pid, 12345, null, "opencode-api", "idle", now],
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

	it("keeps distributed arms in current state", async () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, name, pid, port, agent_id, harness, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["arm-3", "arm-3", 999999, 19301, "agent-1", "opencode-api", "idle", now],
		);

		await cleanupOrphanedArms(db);

		const arm = db
			.query("SELECT id, status, pid, port, agent_id FROM arms WHERE id = ?")
			.get("arm-3") as ArmRow | null;
		expect(arm).not.toBeNull();
		expect(arm?.status).toBe("idle");
		expect(arm?.pid).toBe(999999);
		expect(arm?.port).toBe(19301);
		expect(arm?.agent_id).toBe("agent-1");
	});

	it("marks dead local arms as stopped and releases their active claims", async () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, name, pid, port, agent_id, harness, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			["arm-4", "arm-4", 999999, 17321, null, "opencode-api", "running", now],
		);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-4", "src/stale.ts", "write", now],
		);

		await cleanupOrphanedArms(db);

		const arm = db
			.query("SELECT status, pid, port FROM arms WHERE id = ?")
			.get("arm-4") as { status: string; pid: number | null; port: number | null } | null;
		expect(arm).not.toBeNull();
		expect(arm?.status).toBe("stopped");
		expect(arm?.pid).toBeNull();
		expect(arm?.port).toBeNull();

		const claim = db
			.query("SELECT released_at FROM claims WHERE arm_id = ? AND file_path = ?")
			.get("arm-4", "src/stale.ts") as { released_at: string | null } | null;
		expect(claim).not.toBeNull();
		expect(typeof claim?.released_at).toBe("string");
	});
});
