/**
 * Garden utilities
 * 
 * Helper functions for the garden visualization system
 * Extracted from garden.ts to reduce file size
 */

import type { Database } from "bun:sqlite";
import { eventStore } from "../../nats/jetstream";
import type { FileClaim } from "./garden";

/**
 * Get all active file claims from the database
 */
export function getActiveClaims(db: Database): FileClaim[] {
	try {
		return db
			.query(
				`SELECT id, arm_id as armId, file_path as filePath, claim_type as claimType,
         claimed_at as claimedAt, released_at as releasedAt
         FROM claims
         WHERE released_at IS NULL
         ORDER BY claimed_at DESC`,
			)
			.all() as FileClaim[];
	} catch {
		return [];
	}
}

/**
 * Get recent activity from JetStream
 * Note: This is now async - callers need to await it
 */
export async function getRecentActivity(): Promise<
	Array<{ actor: string; target: string | null; timestamp: string }>
> {
	if (!eventStore.isInitialized()) {
		return [];
	}

	try {
		const events = await eventStore.getRecentEvents(100);
		return events
			.filter((e) => e.data.target || e.data.filePath)
			.map((e) => ({
				actor: e.armId || (e.data.actor as string) || "unknown",
				target: (e.data.target || e.data.filePath) as string | null,
				timestamp: e.timestamp,
			}));
	} catch {
		return [];
	}
}

/**
 * Generate 3D coordinates based on file path
 * Uses path components to create a deterministic position
 */
export function generateCoords(filePath: string): {
	x: number;
	y: number;
	z: number;
} {
	const parts = filePath.split("/");
	const hash = simpleHash(filePath);

	// Use directory depth for Y coordinate
	const y = parts.length * 10;

	// Use hash for X and Z spread
	const x = ((hash % 360) / 360) * 100 - 50;
	const z = (((hash >> 8) % 360) / 360) * 100 - 50;

	return { x, y, z };
}

/**
 * Simple string hash for coordinate generation
 */
function simpleHash(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash);
}
