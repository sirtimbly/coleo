/**
 * Daemon Utilities
 * 
 * Utility functions for service management.
 */

import { getColeoDir } from "../config";

/**
 * Check if self-modify operations are allowed
 * Requires COLEO_SELF_MODIFY=1 environment variable
 */
export function isSelfModifyAllowed(): boolean {
	return process.env.COLEO_SELF_MODIFY === "1";
}

/**
 * Require self-modify permission for an action
 * Throws an error if COLEO_SELF_MODIFY is not set
 */
export function requireSelfModify(action: string): void {
	if (!isSelfModifyAllowed()) {
		throw new Error(
			`${action} requires COLEO_SELF_MODIFY=1 environment variable. ` +
				`This should only be set for arms working on Coleo itself.`,
		);
	}
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Format uptime in human-readable format
 */
export function formatUptime(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	if (seconds < 3600) {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}m ${secs}s`;
	}
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${mins}m`;
}
