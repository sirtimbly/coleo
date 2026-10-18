/**
 * Arm Cleanup Utilities
 * 
 * Functions for cleaning up orphaned arms on server startup.
 */

import type { Database } from "../db";
import type { HarnessManager } from "../harness";
import { releaseClaimsForArm } from "./claim-cleanup";

/**
 * Clean up orphaned arms on server startup
 * 
 * When the server restarts, any arms that were running via harness manager
 * are lost (the sessions were tied to the old server process).
 * This function detects such orphaned arms and either:
 * - Recovers them if the process is still running and has a recoverable session endpoint
 * - Preserves running state when the process is alive but recovery is not yet possible
 * - Marks them as stopped only when the process is confirmed dead
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
		SELECT id, name, pid, port, harness, status, agent_id
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
		agent_id: string | null;
	}>;

	let orphanedCount = 0;
	let recoveredCount = 0;
	let preservedCount = 0;

	for (const arm of runningArms) {
		// Distributed arms run on remote agents. Their PID is not local to this process,
		// so process.kill(pid, 0) is not a valid liveness check after API restart.
		if (arm.agent_id) {
			console.log(
				`[cleanup] Preserving distributed arm state: ${arm.name} (${arm.id}) on agent ${arm.agent_id}`,
			);
			preservedCount++;
			continue;
		}

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
			const releasedClaims = releaseClaimsForArm(db, arm.id, now);
			if (releasedClaims > 0) {
				console.log(
					`[cleanup] Released ${releasedClaims} stale file claim(s) for stopped arm: ${arm.name}`,
				);
			}
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
					`[cleanup] Failed to recover arm: ${arm.name}, preserving state for retry`,
				);
				preservedCount++;
			}
		} else if (isAlive) {
			// Process is alive but session cannot be recovered by this server process.
			// Preserve state so components can retry recovery instead of forcing a stop.
			console.log(
				`[cleanup] Arm ${arm.name} has running process (PID ${arm.pid}) but no recoverable session, preserving state`,
			);
			preservedCount++;
		}
	}

	if (orphanedCount > 0) {
		console.log(`[cleanup] Cleaned up ${orphanedCount} orphaned arm(s)`);
	}
	if (recoveredCount > 0) {
		console.log(`[cleanup] Recovered ${recoveredCount} arm session(s)`);
	}
	if (preservedCount > 0) {
		console.log(
			`[cleanup] Preserved ${preservedCount} running arm(s) without forcing stop`,
		);
	}
}
