/**
 * MCP Tools Utilities
 * 
 * Shared utilities for MCP tool implementations.
 */

import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getColeoDir } from "../../config";
import { createApiDatabase } from "../api-db";
import type { MessageType, QueueMessage, Task } from "../../types";
import { createCommandEnvelope } from "../../nats/command-types";

// Get coleo directory from env or default (project-local)
export const COLEO_DIR = getColeoDir();
export const ARM_ID =
	process.env.COLEO_ARM_ID || process.env.COLEO_TENTACLE_ID || "unknown";
export const PROJECT_ROOT = process.env.COLEO_PROJECT_ROOT || process.cwd();
export const API_BASE_URL = process.env.COLEO_API_URL || "http://127.0.0.1:8080";
export const API_KEY = process.env.COLEO_API_KEY || "dev-api-key-12345";

type StateDb = ReturnType<typeof createApiDatabase>;

// API-backed database proxy connection (lazy initialization)
let dbClient: StateDb | null = null;

/**
 * Get database client
 */
export function getDatabase(_readonly = true): StateDb {
	if (!dbClient) {
		dbClient = createApiDatabase(API_BASE_URL, API_KEY);
	}
	return dbClient;
}

/**
 * Send a message to the brain
 */
export async function sendToBrain(message: {
	from: string;
	to: string;
	type: MessageType;
	payload: unknown;
}): Promise<string> {
	const envelope = createCommandEnvelope({
		id: `${Date.now()}-${randomBytes(4).toString("hex")}`,
		from: message.from,
		to: message.to,
		type: message.type,
		payload: message.payload,
	});
	try {
		const response = await fetch(`${API_BASE_URL}/api/brain/internal/commands/publish`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": API_KEY,
			},
			body: JSON.stringify(envelope),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`API queue failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
			);
		}

		return envelope.id;
	} catch (err) {
		console.error(`[MCP] Failed to queue message via API, falling back to file: ${err}`);
	}

	await sendToBrainFile({
		id: envelope.id,
		from: envelope.from,
		to: envelope.to,
		type: envelope.type as QueueMessage["type"],
		payload: envelope.payload,
		timestamp: new Date(envelope.createdAt),
	});

	return envelope.id;
}

async function sendToBrainFile(message: QueueMessage): Promise<void> {
	const queueDir = join(COLEO_DIR, "queue", "brain", "pending");
	await mkdir(queueDir, { recursive: true });

	const filename = `${message.id}-${message.from}-${message.type}.json`;
	await writeFile(
		join(queueDir, filename),
		JSON.stringify(message, null, 2),
		"utf-8",
	);
}

/**
 * Log activity
 */
export function logActivity(
	armId: string,
	action: string,
	target?: string,
	details?: Record<string, unknown>,
): void {
	console.error(`[MCP] Activity: ${armId} ${action}${target ? ` ${target}` : ""}`,
		details ? JSON.stringify(details) : "",
	);
}

/**
 * Get pending tasks from the database
 */
export async function getPendingTasks(): Promise<Task[]> {
	// Implementation would query the database
	// For now, return empty array as stub
	return [];
}
