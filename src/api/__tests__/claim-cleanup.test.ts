import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	releaseClaimsForArm,
	releaseClaimsForInactiveArms,
} from "../claim-cleanup";

describe("claim-cleanup", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
      CREATE TABLE arms (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        pid INTEGER,
        port INTEGER,
        agent_id TEXT,
        updated_at TEXT
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

	it("releases all active claims for a specific arm", () => {
		const now = new Date().toISOString();
		db.run("INSERT INTO arms (id, status) VALUES (?, ?)", ["arm-a", "idle"]);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-a", "src/a.ts", "write", now],
		);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-a", "src/b.ts", "write", now],
		);

		const released = releaseClaimsForArm(db, "arm-a", now);
		expect(released).toBe(2);

		const active = db
			.query(
				"SELECT COUNT(*) as count FROM claims WHERE arm_id = ? AND released_at IS NULL",
			)
			.get("arm-a") as { count: number } | null;
		expect(active?.count).toBe(0);
	});

	it("releases claims held by stopped or missing arms", () => {
		const now = new Date().toISOString();
		db.run("INSERT INTO arms (id, status) VALUES (?, ?)", ["arm-idle", "idle"]);
		db.run("INSERT INTO arms (id, status) VALUES (?, ?)", ["arm-stopped", "stopped"]);

		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-idle", "src/idle.ts", "write", now],
		);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-stopped", "src/stopped.ts", "write", now],
		);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-missing", "src/missing.ts", "write", now],
		);

		const released = releaseClaimsForInactiveArms(db, now);
		expect(released).toBe(2);

		const idleClaim = db
			.query("SELECT released_at FROM claims WHERE arm_id = ?")
			.get("arm-idle") as { released_at: string | null } | null;
		const stoppedClaim = db
			.query("SELECT released_at FROM claims WHERE arm_id = ?")
			.get("arm-stopped") as { released_at: string | null } | null;
		const missingClaim = db
			.query("SELECT released_at FROM claims WHERE arm_id = ?")
			.get("arm-missing") as { released_at: string | null } | null;

		expect(idleClaim?.released_at).toBeNull();
		expect(stoppedClaim?.released_at).not.toBeNull();
		expect(missingClaim?.released_at).not.toBeNull();
	});

	it("releases claims held by local arms whose PID is no longer alive", () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, status, pid, updated_at) VALUES (?, ?, ?, ?)",
			["arm-dead", "idle", 999999, now],
		);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-dead", "src/dead.ts", "write", now],
		);

		const released = releaseClaimsForInactiveArms(db, now);
		expect(released).toBe(1);

		const claim = db
			.query("SELECT released_at FROM claims WHERE arm_id = ?")
			.get("arm-dead") as { released_at: string | null } | null;
		const arm = db
			.query("SELECT status, pid FROM arms WHERE id = ?")
			.get("arm-dead") as { status: string; pid: number | null } | null;

		expect(claim?.released_at).not.toBeNull();
		expect(arm?.status).toBe("stopped");
		expect(arm?.pid).toBeNull();
	});

	it("keeps claims for distributed arms even if local PID check would fail", () => {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO arms (id, status, pid, agent_id, updated_at) VALUES (?, ?, ?, ?, ?)",
			["arm-remote", "idle", 999999, "agent-1", now],
		);
		db.run(
			"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
			["arm-remote", "src/remote.ts", "write", now],
		);

		const released = releaseClaimsForInactiveArms(db, now);
		expect(released).toBe(0);

		const claim = db
			.query("SELECT released_at FROM claims WHERE arm_id = ?")
			.get("arm-remote") as { released_at: string | null } | null;
		expect(claim?.released_at).toBeNull();
	});
});
