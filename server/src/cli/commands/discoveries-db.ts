/**
 * Discoveries database operations
 * 
 * Extracted from discoveries.ts to reduce file size
 */

import type { Database } from "bun:sqlite";

export interface DiscoveryRow {
	id: string;
	kind: string;
	title: string;
	details: string;
	file_path: string | null;
	line_number: number | null;
	severity: string;
	task_id: string | null;
	phase: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	metadata: string;
}

export type DiscoveryKind =
	| "test_failure"
	| "unused_code"
	| "security_issue"
	| "performance"
	| "pattern"
	| "missing_context"
	| "ambiguous_requirement"
	| "potential_blocker"
	| "related_code"
	| "suggested_approach"
	| "other";

export interface Discovery {
	kind: DiscoveryKind;
	title: string;
	details: string;
	file?: string;
	line?: number;
	severity: "info" | "warning" | "error";
	taskId?: string;
	phase: "exploration" | "implementation" | "verification";
}

/**
 * Get all open discoveries
 */
export function getOpenDiscoveries(db: Database, limit = 50): DiscoveryRow[] {
	return db
		.query(
			`
      SELECT id, kind, title, details, file_path, line_number, severity, task_id, phase, status, created_at, updated_at, metadata
      FROM discoveries
      WHERE status = 'open'
      ORDER BY created_at DESC
      LIMIT ?
    `,
		)
		.all(limit) as DiscoveryRow[];
}

/**
 * Get open discoveries for a specific task
 */
export function getTaskDiscoveries(db: Database, taskId: string): DiscoveryRow[] {
	return db
		.query(
			`
      SELECT id, kind, title, details, file_path, line_number, severity, task_id, phase, status, created_at, updated_at, metadata
      FROM discoveries
      WHERE task_id = ? AND status = 'open'
      ORDER BY created_at DESC
    `,
		)
		.all(taskId) as DiscoveryRow[];
}

/**
 * Get open discoveries filtered by phase
 */
export function getDiscoveriesByPhase(
	db: Database,
	phase: string,
	limit = 20,
): DiscoveryRow[] {
	return db
		.query(
			`
      SELECT id, kind, title, details, file_path, severity, phase, task_id, created_at
      FROM discoveries
      WHERE status = 'open' AND phase = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
		)
		.all(phase, limit) as DiscoveryRow[];
}

/**
 * Get resolved/dismissed discoveries
 */
export function getResolvedDiscoveries(db: Database, limit = 20): DiscoveryRow[] {
	return db
		.query(
			`
      SELECT id, kind, title, status, severity, updated_at, metadata
      FROM discoveries
      WHERE status IN ('resolved', 'dismissed')
      ORDER BY updated_at DESC
      LIMIT ?
    `,
		)
		.all(limit) as DiscoveryRow[];
}

/**
 * Find a discovery by title match
 */
export function findDiscoveryByTitle(
	db: Database,
	title: string,
): DiscoveryRow | null {
	return db
		.query(
			`
      SELECT id, title, kind, severity, details
      FROM discoveries
      WHERE status = 'open' AND title LIKE ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
		)
		.get(`%${title}%`) as DiscoveryRow | null;
}

/**
 * Resolve or dismiss a discovery
 */
export function resolveDiscovery(
	db: Database,
	id: string,
	resolution: "resolved" | "dismissed",
	reason: string,
	resolvedBy: string,
): void {
	const now = new Date().toISOString();

	db.run(
		`
    UPDATE discoveries 
    SET status = ?, 
        updated_at = ?,
        metadata = json_set(COALESCE(metadata, '{}'), '$.resolution_reason', ?, '$.resolved_by', ?, '$.resolved_at', ?)
    WHERE id = ?
  `,
		[resolution, now, reason, resolvedBy, now, id],
	);
}

/**
 * Convert a database row to a Discovery object
 */
export function toDiscovery(row: DiscoveryRow): Discovery {
	return {
		kind: (row.kind as DiscoveryKind) || "other",
		title: row.title,
		details: row.details,
		file: row.file_path || undefined,
		line: row.line_number || undefined,
		severity: (row.severity || "info") as "info" | "warning" | "error",
		taskId: row.task_id || undefined,
		phase: (row.phase || "implementation") as "exploration" | "implementation" | "verification",
	};
}

/**
 * Format a discovery for display
 */
export function formatDiscovery(d: DiscoveryRow): string {
	const phase = d.phase ? `[${d.phase.toUpperCase()}]` : "";
	const severity = `[${(d.severity || "info").toUpperCase()}]`;
	const file = d.file_path ? ` @ ${d.file_path}` : "";
	const taskRef = d.task_id ? ` (task: ${d.task_id.substring(0, 20)}...)` : "";

	return `${phase} ${severity} ${d.kind}: ${d.title}${file}${taskRef}\n  ${d.details.substring(0, 100)}${d.details.length > 100 ? "..." : ""}`;
}

/**
 * Get resolution reason from metadata
 */
export function getResolutionReason(metadata: string): string | null {
	try {
		const meta = JSON.parse(metadata || "{}");
		return meta.resolution_reason || null;
	} catch {
		return null;
	}
}
