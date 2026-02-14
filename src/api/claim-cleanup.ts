import type { Database } from "../db";

const INACTIVE_ARM_STATUSES = ["stopped", "error"] as const;

interface TableInfoRow {
	name: string;
}

function hasColumn(db: Database, table: string, column: string): boolean {
	try {
		const columns = db
			.query(`PRAGMA table_info(${table})`)
			.all() as TableInfoRow[];
		return columns.some((row) => row.name === column);
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM means the process exists but we don't have permission to signal it.
		return code === "EPERM";
	}
}

/**
 * Release all active claims owned by an arm.
 */
export function releaseClaimsForArm(
	db: Database,
	armId: string,
	releasedAt = new Date().toISOString(),
): number {
	try {
		const result = db.run(
			"UPDATE claims SET released_at = ? WHERE arm_id = ? AND released_at IS NULL",
			[releasedAt, armId],
		);
		return result.changes ?? 0;
	} catch {
		// Claims table may not exist yet in early setup/testing paths.
		return 0;
	}
}

/**
 * Release all active claims owned by inactive or missing arms.
 */
export function releaseClaimsForInactiveArms(
	db: Database,
	releasedAt = new Date().toISOString(),
): number {
	try {
		const statusPlaceholders = INACTIVE_ARM_STATUSES.map(() => "?").join(", ");
		const params: string[] = [releasedAt, ...INACTIVE_ARM_STATUSES];

		const result = db.run(
			`UPDATE claims
	       SET released_at = ?
	       WHERE released_at IS NULL
	         AND (
	           arm_id NOT IN (SELECT id FROM arms)
	           OR arm_id IN (SELECT id FROM arms WHERE status IN (${statusPlaceholders}))
	         )`,
			params,
		);

		let releasedCount = result.changes ?? 0;

		// Best-effort local liveness check for arms that still look active in DB but whose PID is gone.
		// This handles stale claims after partial restarts or unexpected child process exits.
		if (!hasColumn(db, "arms", "pid")) {
			return releasedCount;
		}

		const hasAgentId = hasColumn(db, "arms", "agent_id");
		const statusFilter = INACTIVE_ARM_STATUSES.map(() => "?").join(", ");
		const localArmRows = db
			.query(
				`SELECT DISTINCT a.id as arm_id, a.pid as pid
	         FROM claims c
	         INNER JOIN arms a ON a.id = c.arm_id
	         WHERE c.released_at IS NULL
	           AND a.pid IS NOT NULL
	           ${hasAgentId ? "AND (a.agent_id IS NULL OR a.agent_id = '')" : ""}
	           AND a.status NOT IN (${statusFilter})`,
			)
			.all(...INACTIVE_ARM_STATUSES) as Array<{ arm_id: string; pid: number | null }>;

		const staleArmIds = localArmRows
			.filter((row) => typeof row.pid === "number" && !isProcessAlive(row.pid))
			.map((row) => row.arm_id);

		if (staleArmIds.length === 0) {
			return releasedCount;
		}

		const stalePlaceholders = staleArmIds.map(() => "?").join(", ");
		const staleClaims = db.run(
			`UPDATE claims
	         SET released_at = ?
	         WHERE released_at IS NULL
	           AND arm_id IN (${stalePlaceholders})`,
			[releasedAt, ...staleArmIds],
		);
		releasedCount += staleClaims.changes ?? 0;

		const armUpdates: string[] = ["status = 'stopped'"];
		const armUpdateParams: Array<string> = [];
		if (hasColumn(db, "arms", "pid")) {
			armUpdates.push("pid = NULL");
		}
		if (hasColumn(db, "arms", "port")) {
			armUpdates.push("port = NULL");
		}
		if (hasColumn(db, "arms", "updated_at")) {
			armUpdates.push("updated_at = ?");
			armUpdateParams.push(releasedAt);
		}
		db.run(
			`UPDATE arms SET ${armUpdates.join(", ")} WHERE id IN (${stalePlaceholders})`,
			[...armUpdateParams, ...staleArmIds],
		);

		return releasedCount;
	} catch {
		// Arms/claims tables may not exist yet.
		return 0;
	}
}
