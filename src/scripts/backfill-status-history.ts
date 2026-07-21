/**
 * Backfill SQLite status_reports into Qdrant status-history collection.
 *
 * Usage:
 *   bun run backfill:status-history
 *   bun run backfill:status-history -- --dry-run --limit 50
 *   bun run backfill:status-history -- --db /path/to/coleo.db
 *
 * Env:
 *   COLEO_DIR / database via getColeoDir
 *   COLEO_QDRANT_URL
 *   COLEO_EMBEDDING_PROVIDER / OPENAI_API_KEY
 */

import { join } from "path";
import { Database } from "bun:sqlite";
import { getColeoDir } from "../cli/context";
import { indexStatusHistoryEvent, initializeStatusHistoryCollection } from "../vector/indexing-pipeline";
import type { StatusHistoryEvent } from "../vector/status-history";

interface StatusReportRow {
	id: string;
	task_id: string;
	arm_id: string;
	status: string;
	summary: string;
	issues: string;
	blockers: string;
	next_steps: string | null;
	files_changed: string;
	tests_status: string | null;
	created_at: string;
}

interface CompletedTaskRow {
  id: string;
  subject: string;
  description: string;
  assigned_to: string | null;
  completed_at: string;
  artifacts: string | null;
  metadata: string | null;
}

function parseArgs(argv: string[]): {
	dryRun: boolean;
	limit: number | null;
	dbPath: string | null;
	batchSize: number;
} {
	let dryRun = false;
	let limit: number | null = null;
	let dbPath: string | null = null;
	let batchSize = 25;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--dry-run") dryRun = true;
		else if (arg === "--limit" && argv[i + 1]) {
			limit = Number.parseInt(argv[++i]!, 10);
		} else if (arg.startsWith("--limit=")) {
			limit = Number.parseInt(arg.slice("--limit=".length), 10);
		} else if (arg === "--db" && argv[i + 1]) {
			dbPath = argv[++i]!;
		} else if (arg.startsWith("--db=")) {
			dbPath = arg.slice("--db=".length);
		} else if (arg === "--batch-size" && argv[i + 1]) {
			batchSize = Number.parseInt(argv[++i]!, 10);
		}
	}

	return { dryRun, limit, dbPath, batchSize };
}

function parseJsonArray(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

export function statusReportToHistoryEvent(row: StatusReportRow): StatusHistoryEvent {
	const issues = parseJsonArray(row.issues);
	const blockers = parseJsonArray(row.blockers);
	const filesChanged = parseJsonArray(row.files_changed);

	const contentParts = [row.summary];
	if (issues.length) contentParts.push(`Issues: ${issues.join("; ")}`);
	if (blockers.length) contentParts.push(`Blockers: ${blockers.join("; ")}`);
	if (row.next_steps) contentParts.push(`Next steps: ${row.next_steps}`);
	if (filesChanged.length) contentParts.push(`Files: ${filesChanged.join(", ")}`);
	if (row.tests_status) contentParts.push(`Tests: ${row.tests_status}`);

	const status = row.status as StatusHistoryEvent["status"];

	return {
		id: `status-report-${row.id}`,
		type: "status_report",
		timestamp: row.created_at.includes("T")
			? row.created_at
			: new Date(row.created_at.replace(" ", "T") + "Z").toISOString(),
		source: row.arm_id,
		title: `Status: ${row.status.replace(/_/g, " ")} — task ${row.task_id}`,
		content: contentParts.join("\n\n"),
		taskId: row.task_id,
		armId: row.arm_id,
		status,
		metadata: {
			reportId: row.id,
			issues,
			blockers,
			nextSteps: row.next_steps,
			filesChanged,
			testsStatus: row.tests_status,
			backfill: true,
		},
	};
}

export function completedTaskToHistoryEvent(row: CompletedTaskRow): StatusHistoryEvent {
  const artifacts = parseJsonArray(row.artifacts);
  const metadata = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {};
  const timestamp = row.completed_at.includes("T")
    ? row.completed_at
    : new Date(row.completed_at.replace(" ", "T") + "Z").toISOString();
  return {
    id: `task-completion-${row.id}`,
    type: "task_completion",
    timestamp,
    source: row.assigned_to || "system",
    title: row.subject,
    content: row.description,
    taskId: row.id,
    armId: row.assigned_to || undefined,
    metadata: { task: row, artifacts, taskMetadata: metadata, backfill: true },
  };
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const dbPath = opts.dbPath || join(getColeoDir(), "coleo.db");

	console.log(`[backfill] db=${dbPath}`);
	console.log(`[backfill] dryRun=${opts.dryRun} limit=${opts.limit ?? "all"} batch=${opts.batchSize}`);

	const db = new Database(dbPath, { readonly: true });

	const table = db
		.query("SELECT name FROM sqlite_master WHERE type='table' AND name='status_reports'")
		.get() as { name: string } | null;

	if (!table) {
		console.log("[backfill] No status_reports table — nothing to do.");
		db.close();
		return;
	}

	const limitSql = opts.limit && opts.limit > 0 ? ` LIMIT ${opts.limit}` : "";
  const rows = db
		.query(
			`SELECT id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
       FROM status_reports
       ORDER BY created_at ASC${limitSql}`,
		)
    .all() as StatusReportRow[];

  const completionRows = db.query(
    `SELECT id, subject, description, assigned_to, completed_at, artifacts, metadata
     FROM tasks WHERE status = 'completed' AND completed_at IS NOT NULL
     ORDER BY completed_at ASC${limitSql}`,
  ).all() as CompletedTaskRow[];

	db.close();

  console.log(`[backfill] found ${rows.length} status reports and ${completionRows.length} completed tasks`);

  const events = [...rows.map(statusReportToHistoryEvent), ...completionRows.map(completedTaskToHistoryEvent)]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (events.length === 0) {
		console.log("[backfill] done (empty)");
		return;
	}

	if (!opts.dryRun) {
		await initializeStatusHistoryCollection();
	}

	let indexed = 0;
	let failed = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

		if (opts.dryRun) {
			console.log(
				`[dry-run] ${event.id} arm=${event.armId} status=${event.status} ts=${event.timestamp}`,
			);
			indexed++;
			continue;
		}

		try {
			await indexStatusHistoryEvent(event);
			indexed++;
			if (indexed % opts.batchSize === 0) {
        console.log(`[backfill] indexed ${indexed}/${events.length}`);
			}
		} catch (err) {
			failed++;
			console.error(
				`[backfill] fail ${event.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	console.log(`[backfill] complete indexed=${indexed} failed=${failed}`);
}

// Export for unit tests; run main when executed as script
if (import.meta.main) {
	main().catch((err) => {
		console.error("[backfill] FAIL:", err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
