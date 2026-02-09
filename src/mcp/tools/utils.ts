/**
 * MCP Tools Utilities
 * 
 * Shared utilities for MCP tool implementations.
 */

import { getColeoDir } from "../../config";
import { createApiDatabase } from "../api-db";
import type { Task } from "../../types";

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
	type: string;
	payload: Record<string, unknown>;
}): Promise<string> {
	// Implementation would go here - for now, stub
	const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
	console.error(`[MCP] Sending message to brain: ${message.type}`);
	return messageId;
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
