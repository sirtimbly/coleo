/**
 * Arm Cleanup Utilities
 * 
 * Functions for cleaning up orphaned arms on server startup.
 */

import type { Database } from "../db";
import type { HarnessManager } from "../harness";

/**
 * Clean up orphaned arms on server startup
 * 
 * When the server restarts, any arms that were running via harness manager
 * are lost (the sessions were tied to the old server process).
 * This function detects such orphaned arms and either:
 * - Recovers them if the process is still running and has a known port
 * - Marks them as stopped if the process is dead
 */
export async function cleanupOrphanedArms(
	db: Database,
	harnessManager?: HarnessManager,
): Promise<void> {
	const now = new Date().toISOString();

	// Find arms that were marked as running
	const runningArms = db
		.query(
			`
		SELECT id, name, pid, port, harness, status
		FROM arms
		WHERE status IN ('idle', 'busy', 'running', 'starting')
	`,
		)
		.all() as Array<{
		id: string;
		name: string;
		pid: number | null;
		port: number | null;
		harness: string;
		status: string;
	}>;

	let orphanedCount = 0;
	let recoveredCount = 0;

	for (const arm of runningArms) {
		let isAlive = false;

		if (arm.pid) {
			try {
				process.kill(arm.pid, 0);
				isAlive = true;
			} catch {
				isAlive = false;
			}
		}

		if (!isAlive) {
			console.log(
				`[cleanup] Marking orphaned arm as stopped: ${arm.name} (${arm.id})`,
			);
			db.run(
				"UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?",
				[now, arm.id],
			);
			orphanedCount++;
		} else if (
			harnessManager &&
			arm.port &&
			(arm.harness === "opencode-api" || arm.harness === "opencode-tui")
		) {
			// Try to recover the session
			console.log(
				`[cleanup] Attempting to recover arm: ${arm.name} (port ${arm.port})`,
			);
			const recovered = await harnessManager.recover(
				arm.id,
				arm.harness,
				arm.port,
				arm.pid!,
			);
			if (recovered) {
				recoveredCount++;
				console.log(`[cleanup] Successfully recovered arm: ${arm.name}`);
			} else {
				console.log(
					`[cleanup] Failed to recover arm: ${arm.name}, marking as stopped`,
				);
				db.run(
					"UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?",
					[now, arm.id],
				);
				orphanedCount++;
			}
		} else if (isAlive) {
			// Process is alive but can't recover - just log it
			console.log(
				`[cleanup] Arm ${arm.name} has running process (PID ${arm.pid}) but cannot recover session`,
			);
		}
	}

	if (orphanedCount > 0) {
		console.log(`[cleanup] Cleaned up ${orphanedCount} orphaned arm(s)`);
	}
	if (recoveredCount > 0) {
		console.log(`[cleanup] Recovered ${recoveredCount} arm session(s)`);
	}
}
