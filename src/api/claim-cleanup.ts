import type { Database } from "../db";

const INACTIVE_ARM_STATUSES = ["stopped"] as const;

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

		return result.changes ?? 0;
	} catch {
		// Arms/claims tables may not exist yet.
		return 0;
	}
}
