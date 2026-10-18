import type { Database } from "bun:sqlite";

import type { BrainTaskListFilters, BrainTaskRecord } from "../brain/db-client";
import { compareKeys } from "../lib/fractional-indexing";

export function getTableColumns(db: Database, table: string): Set<string> {
	try {
		const rows = db
			.query(`PRAGMA table_info(${table})`)
			.all() as Array<{ name: string }>;
		return new Set(rows.map((row) => row.name));
	} catch {
		return new Set<string>();
	}
}

export function hasColumn(columns: Set<string>, name: string): boolean {
	return columns.has(name);
}

export function mapTaskRows(rows: Array<Record<string, unknown>>): BrainTaskRecord[] {
	return rows.map((row) => ({
		id: String(row.id || ""),
		subject: String(row.subject || ""),
		description: String(row.description || ""),
		status: String(row.status || "pending"),
		priority: String(row.priority || "normal"),
		sourceType: String(row.source_type || "manual"),
		sourceRef: (row.source_ref as string | null) ?? null,
		phase: (row.phase as string | null) ?? null,
		domain: (row.domain as string | null) ?? null,
		classification: (row.classification as string | null) ?? null,
		assignedTo: (row.assigned_to as string | null) ?? null,
		dependencyBlocked:
			Number(row.dependency_blocked || 0) === 1 || row.dependency_blocked === true,
		consensusStatus: (row.consensus_status as string | null) ?? null,
	sortOrder:
		row.sort_order === null || row.sort_order === undefined
			? null
			: Number(row.sort_order),
	orderKey: (row.order_key as string | null) ?? null,
	createdAt: String(row.created_at || new Date(0).toISOString()),
		updatedAt: String(row.updated_at || row.created_at || new Date(0).toISOString()),
		completedAt: (row.completed_at as string | null) ?? null,
	}));
}

export function sortTasks(
	rows: BrainTaskRecord[],
	sort: NonNullable<BrainTaskListFilters["sort"]>,
): BrainTaskRecord[] {
	const tasks = [...rows];
	switch (sort) {
		case "created_asc":
			tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			return tasks;
		case "updated_desc":
			tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			return tasks;
		case "completed_desc":
			tasks.sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
			return tasks;
		case "priority_then_created_asc":
			tasks.sort((a, b) => {
				const rank = (priority: string): number => {
					switch (priority) {
						case "critical":
							return 1;
						case "high":
							return 2;
						case "normal":
							return 3;
						case "low":
							return 4;
						default:
							return 5;
					}
				};
				const diff = rank(a.priority) - rank(b.priority);
				if (diff !== 0) {
					return diff;
				}
				return a.createdAt.localeCompare(b.createdAt);
			});
			return tasks;
		case "sort_order_asc":
			tasks.sort((a, b) => {
				const left = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
				const right = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
				if (left !== right) {
					return left - right;
				}
				return a.createdAt.localeCompare(b.createdAt);
			});
			return tasks;
		case "order_key_asc":
			tasks.sort((a, b) => {
				if (a.orderKey === null && b.orderKey === null) {
					return a.createdAt.localeCompare(b.createdAt);
				}
				if (a.orderKey === null) {
					return 1;
				}
				if (b.orderKey === null) {
					return -1;
				}
				const diff = compareKeys(a.orderKey, b.orderKey);
				if (diff !== 0) {
					return diff;
				}
				return a.createdAt.localeCompare(b.createdAt);
			});
			return tasks;
		case "created_desc":
		default:
			tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			return tasks;
	}
}
