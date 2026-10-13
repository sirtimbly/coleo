/**
 * Kimi CLI Event Detector
 * 
 * Detects and emits events from Kimi CLI terminal output.
 */

import { stripAnsi } from "./pty-manager";
import { KIMI_CLI_PATTERNS } from "./kimi-cli-types";
import type { KimiCliHarnessSession } from "./kimi-cli-types";

/**
 * Callback for emitting events
 */
type EmitEventCallback = (armId: string, event: string, data: unknown) => void;

/**
 * Detect events from terminal output and emit them
 */
export function detectAndEmitEvents(
	session: KimiCliHarnessSession,
	armId: string,
	data: string,
	emitEvent: EmitEventCallback,
): void {
	const stripped = stripAnsi(data);

	// Detect approval requests
	if (KIMI_CLI_PATTERNS.approval.test(stripped)) {
		emitEvent(armId, "permission.asked", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
			context: stripped.slice(-500), // Last 500 chars for context
		});
	}

	// Detect errors
	if (KIMI_CLI_PATTERNS.error.test(stripped)) {
		emitEvent(armId, "session.error", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
			output: stripped,
		});
	}

	// Update heartbeat
	session.lastHeartbeat = new Date();
}
