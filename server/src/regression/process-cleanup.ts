/**
 * Process Cleanup Utilities
 * 
 * Functions for cleaning up orphaned test processes.
 */

import { spawn } from "bun";

/**
 * Clean up orphaned test processes from previous runs
 * This helps ensure we don't have port conflicts or stale processes
 */
export async function cleanupOrphanedProcesses(): Promise<void> {
	// Kill any processes listening on test ports (18000-18100)
	// and OpenCode test ports (19300-19400)
	try {
		// Find and kill processes on test API ports
		const lsofApi = spawn(["lsof", "-t", "-i", ":18000-18100"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const apiPids = await new Response(lsofApi.stdout).text();
		for (const pid of apiPids.trim().split("\n").filter(Boolean)) {
			if (pid === String(process.pid)) continue; // Don't kill self
			try {
				process.kill(parseInt(pid, 10), "SIGKILL");
			} catch {
				// Process may not exist
			}
		}

		// Find and kill processes on OpenCode test ports
		const lsofOc = spawn(["lsof", "-t", "-i", ":19300-19400"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const ocPids = await new Response(lsofOc.stdout).text();
		for (const pid of ocPids.trim().split("\n").filter(Boolean)) {
			if (pid === String(process.pid)) continue; // Don't kill self
			try {
				process.kill(parseInt(pid, 10), "SIGKILL");
			} catch {
				// Process may not exist
			}
		}
	} catch {
		// lsof may not be available or no processes found - that's fine
	}
}
