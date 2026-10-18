import type { Command } from "commander";
import type { Database } from "bun:sqlite";
import { join } from "path";
import { readdir, readFile } from "fs/promises";
import { getColeoDir } from "../context";

type StatusReportStatus = "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";

const DEFAULT_TASK_ID = "historical-status-reports";

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function extractSection(content: string, heading: string): string | null {
	const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im");
	const match = content.match(pattern);
	if (!match || match.index === undefined) return null;
	const startIndex = match.index + match[0].length;
	const rest = content.slice(startIndex);
	const nextHeading = rest.search(/^##\s+/m);
	const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
	const normalized = normalizeWhitespace(section);
	return normalized || null;
}

function extractDate(content: string, filename: string): string {
	const dateLine = content.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/i);
	if (dateLine?.[1]) {
		return new Date(`${dateLine[1]}T00:00:00.000Z`).toISOString();
	}
	const fileMatch = filename.match(/status-(\d{4}-\d{2}-\d{2})/i);
	if (fileMatch?.[1]) {
		return new Date(`${fileMatch[1]}T00:00:00.000Z`).toISOString();
	}
	return new Date().toISOString();
}

async function findStatusReportFiles(projectDir: string): Promise<string[]> {
	const statusDir = join(projectDir, ".project");
	const entries = await readdir(statusDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.startsWith("status-") && entry.name.endsWith(".md"))
		.map((entry) => join(statusDir, entry.name));
}

async function ensureBackfillTask(db: Database, taskId: string): Promise<void> {
	const existing = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | null;
	if (existing) return;

	const now = new Date().toISOString();
	db.run(
		`INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at, completed_at)
		 VALUES (?, ?, ?, 'completed', 'low', 'manual', ?, ?, ?)`
	,
		[
			taskId,
			"Historical status reports",
			"Backfilled status reports from .project/status-*.md",
			now,
			now,
			now,
		],
	);
}

export function registerStatusReportsCommands(program: Command): void {
	const statusReportsCmd = program
		.command("status-reports")
		.description("Manage status reports");

	statusReportsCmd
		.command("backfill")
		.description("Backfill .project/status-*.md into the status_reports table")
		.option("--project <path>", "Project root directory", process.cwd())
		.option("--task-id <id>", "Task ID to associate with backfilled reports", DEFAULT_TASK_ID)
		.option("--arm-id <id>", "Arm ID to associate with backfilled reports", "human")
		.option("--dry-run", "Show what would be imported without writing to the database", false)
		.action(async (options: { project: string; taskId: string; armId: string; dryRun: boolean }) => {
			const projectDir = options.project;
			const coleoDir = getColeoDir();
			const dbPath = join(coleoDir, "coleo.db");

			const files = await findStatusReportFiles(projectDir);
			if (files.length === 0) {
				console.log("No .project/status-*.md files found.");
				return;
			}

			const { initDatabase } = await import("../../db");
			const db = await initDatabase(dbPath);
			if (!options.dryRun) {
				await ensureBackfillTask(db, options.taskId);
			}

			let inserted = 0;
			let skipped = 0;
			for (const filePath of files) {
				const content = await readFile(filePath, "utf-8");
				const filename = filePath.split("/").pop() || filePath;
				const createdAt = extractDate(content, filename);
				const summarySection = extractSection(content, "Summary");
				const nextSection = extractSection(content, "Next") || extractSection(content, "Next Suggested Steps");
				const summary = summarySection || normalizeWhitespace(content).slice(0, 200);
				const reportId = `backfill-${filename.replace(/[^a-z0-9_-]/gi, "_")}`;

				const existing = db
					.query("SELECT id FROM status_reports WHERE id = ?")
					.get(reportId) as { id: string } | null;
				if (existing) {
					skipped++;
					continue;
				}

				if (options.dryRun) {
					console.log(`[dry-run] Would insert ${reportId} from ${filename}`);
					inserted++;
					continue;
				}

				db.run(
					`INSERT INTO status_reports (
					  id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					,
					[
						reportId,
						options.taskId,
						options.armId,
						"on_track" as StatusReportStatus,
						summary,
						JSON.stringify([]),
						JSON.stringify([]),
						nextSection || null,
						JSON.stringify([]),
						null,
						createdAt,
					],
				);
				inserted++;
			}

			db.close();
			console.log(`Backfill complete. Inserted: ${inserted}, Skipped: ${skipped}`);
		});
}
