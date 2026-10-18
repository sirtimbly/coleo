/**
 * Enforce status-history retention policy in Qdrant.
 *
 * Usage:
 *   bun run retention:status-history
 *   bun run retention:status-history -- --dry-run
 *
 * Env:
 *   COLEO_QDRANT_URL
 *   COLEO_STATUS_HISTORY_RETENTION_<TYPE>  (days or "forever")
 */

import { applyStatusHistoryRetention, computeRetentionPlan } from "../vector/retention";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
	console.log("[retention] Status history retention");
	console.log(`[retention] dryRun=${dryRun}`);

	const plan = computeRetentionPlan();
	for (const entry of plan) {
		if (entry.days === null) {
			console.log(`  ${entry.type}: forever`);
		} else {
			console.log(`  ${entry.type}: ${entry.days}d (cutoff ${entry.cutoff})`);
		}
	}

	const result = await applyStatusHistoryRetention({ dryRun });
	console.log(`[retention] collection=${result.collection}`);
	console.log(`[retention] purged: ${result.purgedTypes.join(", ") || "(none)"}`);
	console.log(`[retention] skipped: ${result.skippedTypes.join(", ") || "(none)"}`);

	for (const r of result.results) {
		if (r.reason && r.reason !== "forever" && !r.reason.startsWith("dry-run")) {
			console.warn(`  warn ${r.type}: ${r.reason}`);
		}
	}

	console.log("[retention] done");
}

main().catch((err) => {
	console.error("[retention] FAIL:", err instanceof Error ? err.message : err);
	process.exit(1);
});
