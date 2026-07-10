/**
 * Status history retention policy enforcement for Qdrant.
 *
 * Deletes expired points by event type according to STATUS_HISTORY_RETENTION_DAYS.
 * Types with null retention (forever) are never purged.
 */

import { qdrantStore } from "../qdrant";
import {
	STATUS_HISTORY_CONFIG,
	type StatusHistoryEventType,
	getRetentionDaysForType,
} from "./status-history";

export interface RetentionPurgeResult {
	type: StatusHistoryEventType;
	retentionDays: number | null;
	cutoff?: string;
	attempted: boolean;
	skipped: boolean;
	reason?: string;
}

export interface RetentionRunResult {
	collection: string;
	dryRun: boolean;
	results: RetentionPurgeResult[];
	purgedTypes: string[];
	skippedTypes: string[];
}

const ALL_TYPES: StatusHistoryEventType[] = [
	"status_report",
	"task_completion",
	"discovery",
	"bug_report",
	"task_created",
	"task_updated",
	"arm_event",
];

/**
 * Build Qdrant filter for points of a type older than cutoff ISO timestamp.
 */
export function buildExpiredFilter(
	type: StatusHistoryEventType,
	cutoffIso: string,
): Record<string, unknown> {
	return {
		must: [
			{ key: "type", match: { value: type } },
			{ key: "timestamp", range: { lt: cutoffIso } },
		],
	};
}

/**
 * Compute retention cutoffs for each event type (null = keep forever).
 */
export function computeRetentionPlan(
	now: Date = new Date(),
	types: StatusHistoryEventType[] = ALL_TYPES,
): Array<{ type: StatusHistoryEventType; days: number | null; cutoff: string | null }> {
	return types.map((type) => {
		const days = getRetentionDaysForType(type);
		if (days === null) {
			return { type, days: null, cutoff: null };
		}
		const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
		return { type, days, cutoff };
	});
}

/**
 * Apply retention policy to the status-history Qdrant collection.
 */
export async function applyStatusHistoryRetention(options?: {
	dryRun?: boolean;
	now?: Date;
	types?: StatusHistoryEventType[];
	collectionName?: string;
}): Promise<RetentionRunResult> {
	const dryRun = options?.dryRun ?? false;
	const collection = options?.collectionName ?? STATUS_HISTORY_CONFIG.collectionName;
	const plan = computeRetentionPlan(options?.now, options?.types);

	const results: RetentionPurgeResult[] = [];
	const purgedTypes: string[] = [];
	const skippedTypes: string[] = [];

	if (!dryRun) {
		await qdrantStore.initialize();
	}

	for (const entry of plan) {
		if (entry.days === null || !entry.cutoff) {
			results.push({
				type: entry.type,
				retentionDays: null,
				attempted: false,
				skipped: true,
				reason: "forever",
			});
			skippedTypes.push(entry.type);
			continue;
		}

		const filter = buildExpiredFilter(entry.type, entry.cutoff);

		if (dryRun) {
			results.push({
				type: entry.type,
				retentionDays: entry.days,
				cutoff: entry.cutoff,
				attempted: false,
				skipped: true,
				reason: `dry-run filter ${JSON.stringify(filter)}`,
			});
			skippedTypes.push(entry.type);
			continue;
		}

		try {
			await qdrantStore.deleteByFilter(collection, filter);
			results.push({
				type: entry.type,
				retentionDays: entry.days,
				cutoff: entry.cutoff,
				attempted: true,
				skipped: false,
			});
			purgedTypes.push(entry.type);
		} catch (err) {
			results.push({
				type: entry.type,
				retentionDays: entry.days,
				cutoff: entry.cutoff,
				attempted: true,
				skipped: true,
				reason: err instanceof Error ? err.message : String(err),
			});
			skippedTypes.push(entry.type);
		}
	}

	return {
		collection,
		dryRun,
		results,
		purgedTypes,
		skippedTypes,
	};
}
