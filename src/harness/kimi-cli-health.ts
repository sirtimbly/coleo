/**
 * Kimi CLI Health Check Manager
 * 
 * Manages health checking for Kimi CLI sessions.
 */

import type { KimiCliHarnessSession } from "./kimi-cli-types";
import { HEALTH_CHECK_CONFIG } from "./kimi-cli-types";
import type { PTYManager } from "./pty-manager";

/**
 * Callback types for health check events
 */
interface HealthCheckCallbacks {
	onDeath: (armId: string, reason: string) => void;
	onEvent: (armId: string, event: string, data: unknown) => void;
}

/**
 * Manages health checking for Kimi CLI sessions
 */
export class KimiCliHealthManager {
	private ptyManager: PTYManager;
	private callbacks: HealthCheckCallbacks;

	constructor(ptyManager: PTYManager, callbacks: HealthCheckCallbacks) {
		this.ptyManager = ptyManager;
		this.callbacks = callbacks;
	}

	/**
	 * Start health check polling for a session
	 */
	startHealthCheck(
		session: KimiCliHarnessSession,
		onSessionRemove: (sessionId: string) => void,
	): void {
		const { armId } = session;

		session.healthCheckInterval = setInterval(async () => {
			try {
				const isAlive = await this.isSessionAlive(session);

				if (isAlive) {
					// Reset failure counter on success
					session.consecutiveFailures = 0;
					return;
				}

				// Process not responding
				session.consecutiveFailures++;
			} catch {
				// Error checking health counts as failure
				session.consecutiveFailures++;
			}

			// Check if we've exceeded the failure threshold
			if (session.consecutiveFailures >= HEALTH_CHECK_CONFIG.maxFailures) {
				console.log(
					`[harness-kimi] Arm ${armId} health check failed ${session.consecutiveFailures} times, marking as dead`,
				);

				// Stop health checking
				this.stopHealthCheck(session);

				// Remove from sessions
				onSessionRemove(session.id);

				// Notify death callbacks
				this.callbacks.onDeath(
					armId,
					`Health check failed ${session.consecutiveFailures} times`,
				);

				// Emit death event
				this.callbacks.onEvent(armId, "process.died", {
					reason: "health_check_failed",
				});
			}
		}, HEALTH_CHECK_CONFIG.intervalMs);

		console.log(
			`[harness-kimi] Started health check for ${armId} (every ${HEALTH_CHECK_CONFIG.intervalMs}ms)`,
		);
	}

	/**
	 * Stop health check polling for a session
	 */
	stopHealthCheck(session: KimiCliHarnessSession): void {
		if (session.healthCheckInterval) {
			clearInterval(session.healthCheckInterval);
			session.healthCheckInterval = undefined;
		}
	}

	/**
	 * Check if a session's PTY process is still alive
	 */
	async isSessionAlive(session: KimiCliHarnessSession): Promise<boolean> {
		try {
			// Check if we can get the PID - if kill(0) succeeds, process exists
			const pid = this.ptyManager.getPid(session.pty);
			if (pid <= 0) return false;

			// Try to send a signal 0 (doesn't actually signal, just checks if process exists)
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		} catch {
			return false;
		}
	}
}
