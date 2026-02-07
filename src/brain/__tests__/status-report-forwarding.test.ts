/**
 * Status Report Forwarding Tests
 *
 * Tests queue-based forwarding decisions:
 * 1. `on_track` is never forwarded
 * 2. `needs_review` is always forwarded
 * 3. `blocked` is deferred when other pending work exists, otherwise forwarded
 * 4. `issues_found` and `completed_with_issues` are forwarded
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

describe("Status Report Forwarding - Queue-Based Decisions", () => {
	let db: Database;
	let testDir: string;

	beforeEach(async () => {
		testDir = join(
			"/tmp",
			`coleo-status-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		await mkdir(testDir, { recursive: true });

		db = new Database(join(testDir, "test.db"));
		db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
	});

	afterEach(async () => {
		db.close();
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures in tests
		}
	});

	function shouldForwardStatusReportToUser(
		dbConn: Database,
		report: {
			taskId: string;
			status:
				| "on_track"
				| "blocked"
				| "issues_found"
				| "needs_review"
				| "completed_with_issues";
		},
	): { shouldForward: boolean; reason: string; action?: "notify" | "defer_task" } {
		if (report.status === "on_track") {
			return {
				shouldForward: false,
				reason: "Progress update - no user action needed",
			};
		}

		if (report.status === "needs_review") {
			return {
				shouldForward: true,
				reason: "Arm explicitly requested human review",
				action: "notify",
			};
		}

		if (report.status === "blocked") {
			const pendingCount = dbConn
				.query(
					"SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND id != ?",
				)
				.get(report.taskId) as { count: number } | null;
			if ((pendingCount?.count || 0) > 0) {
				return {
					shouldForward: true,
					reason:
						"Task blocked and deferred. Arm will pull other pending work. User notified.",
					action: "defer_task",
				};
			}

			return {
				shouldForward: true,
				reason: "Task is blocked and requires human intervention",
				action: "notify",
			};
		}

		return {
			shouldForward: true,
			reason: "Status requires user visibility and follow-up queue management",
			action: "notify",
		};
	}

	it("does not forward on_track updates", () => {
		const decision = shouldForwardStatusReportToUser(db, {
			taskId: "task-1",
			status: "on_track",
		});
		expect(decision.shouldForward).toBe(false);
	});

	it("always forwards needs_review", () => {
		const decision = shouldForwardStatusReportToUser(db, {
			taskId: "task-1",
			status: "needs_review",
		});
		expect(decision.shouldForward).toBe(true);
		expect(decision.action).toBe("notify");
	});

	it("forwards blocked when no alternate pending tasks exist", () => {
		const decision = shouldForwardStatusReportToUser(db, {
			taskId: "task-1",
			status: "blocked",
		});
		expect(decision.shouldForward).toBe(true);
		expect(decision.action).toBe("notify");
	});

	it("defers blocked when alternate pending tasks exist", () => {
		db.run(
			"INSERT INTO tasks (id, subject, status) VALUES (?, ?, ?)",
			["task-2", "Other pending work", "pending"],
		);
		const decision = shouldForwardStatusReportToUser(db, {
			taskId: "task-1",
			status: "blocked",
		});
		expect(decision.shouldForward).toBe(true);
		expect(decision.action).toBe("defer_task");
	});

	it("forwards completed_with_issues", () => {
		const decision = shouldForwardStatusReportToUser(db, {
			taskId: "task-1",
			status: "completed_with_issues",
		});
		expect(decision.shouldForward).toBe(true);
		expect(decision.action).toBe("notify");
	});

	it("forwards issues_found", () => {
		const decision = shouldForwardStatusReportToUser(db, {
			taskId: "task-1",
			status: "issues_found",
		});
		expect(decision.shouldForward).toBe(true);
		expect(decision.action).toBe("notify");
	});
});
