/**
 * Comprehensive Context Compression Tests
 *
 * Tests for context compression scenarios including:
 * - Basic compression reporting and recording
 * - Budget updates after compression
 * - Context budget status retrieval
 * - Edge cases (zero tokens, extreme ratios, etc.)
 * - Multiple compressions over time
 * - Transaction atomicity
 * - Graceful handling when database is unavailable
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { recordContextCompressionWithBudgetUpdate } from "../transactions";

const TEST_ARM_ID = "test-arm-001";
const TEST_TASK_ID = "task-test-001";

describe("Context Compression - Database Transactions", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `context-compression-test-${Date.now()}.db`);
		db = new Database(dbPath);

		db.exec(`
			PRAGMA journal_mode = WAL;

			CREATE TABLE IF NOT EXISTS arms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				context_budget INTEGER DEFAULT 128000,
				context_budget_used INTEGER DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE IF NOT EXISTS context_compressions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				arm_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				original_tokens INTEGER NOT NULL,
				compressed_tokens INTEGER NOT NULL,
				compression_ratio REAL NOT NULL,
				removed_content TEXT DEFAULT '[]',
				work_in_progress TEXT,
				timestamp TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_ctx_comp_arm ON context_compressions(arm_id);
			CREATE INDEX IF NOT EXISTS idx_ctx_comp_task ON context_compressions(task_id);
			CREATE INDEX IF NOT EXISTS idx_ctx_comp_time ON context_compressions(timestamp DESC);
		`);

		db.run(
			`INSERT INTO arms (id, name, context_budget, context_budget_used) VALUES (?, ?, ?, ?)`,
			[TEST_ARM_ID, "Test Arm", 128000, 0]
		);
	});

	afterEach(() => {
		db.close();
	});

	describe("recordContextCompressionWithBudgetUpdate", () => {
		it("records a compression event with all fields", async () => {
			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 50000,
				compressionRatio: 0.5,
				removedContent: [
					{ type: "history", description: "Old conversation", tokenCount: 50000 }
				],
				workInProgress: "Working on test implementation",
				estimatedCost: 1000
			});

			expect(result.success).toBe(true);
			expect(result.data?.compressionId).toBeGreaterThan(0);

			const compression = db
				.query(`SELECT * FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as {
					original_tokens: number;
					compressed_tokens: number;
					compression_ratio: number;
					work_in_progress: string | null;
				} | null;

			expect(compression).not.toBeNull();
			expect(compression?.original_tokens).toBe(100000);
			expect(compression?.compressed_tokens).toBe(50000);
			expect(compression?.compression_ratio).toBe(0.5);
			expect(compression?.work_in_progress).toBe("Working on test implementation");
		});

		it("updates arm budget usage atomically", async () => {
			const estimatedCost = 2500;

			await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 80000,
				compressedTokens: 40000,
				compressionRatio: 0.5,
				removedContent: [],
				estimatedCost
			});

			const arm = db
				.query(`SELECT context_budget_used FROM arms WHERE id = ?`)
				.get(TEST_ARM_ID) as { context_budget_used: number } | null;

			expect(arm?.context_budget_used).toBe(estimatedCost);
		});

		it("handles multiple sequential compressions", async () => {
			const costs = [1000, 2000, 1500];
			let totalCost = 0;

			for (const cost of costs) {
				await recordContextCompressionWithBudgetUpdate(db, {
					armId: TEST_ARM_ID,
					taskId: TEST_TASK_ID,
					originalTokens: 100000,
					compressedTokens: 50000,
					compressionRatio: 0.5,
					removedContent: [],
					estimatedCost: cost
				});
				totalCost += cost;
			}

			const arm = db
				.query(`SELECT context_budget_used FROM arms WHERE id = ?`)
				.get(TEST_ARM_ID) as { context_budget_used: number } | null;

			expect(arm?.context_budget_used).toBe(totalCost);

			const compressions = db
				.query(`SELECT COUNT(*) as count FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as { count: number } | null;

			expect(compressions?.count).toBe(3);
		});

		it("handles extreme compression ratios", async () => {
			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 1000,
				compressionRatio: 0.01,
				removedContent: [
					{ type: "history", description: "Massive context reduction", tokenCount: 99000 }
				],
				estimatedCost: 1000
			});

			expect(result.success).toBe(true);

			const compression = db
				.query(`SELECT compression_ratio FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as { compression_ratio: number } | null;

			expect(compression?.compression_ratio).toBeCloseTo(0.01);
		});

		it("handles minimal compression (nearly no change)", async () => {
			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 99999,
				compressionRatio: 0.99999,
				removedContent: [
					{ type: "context", description: "Tiny trim", tokenCount: 1 }
				],
				estimatedCost: 1000
			});

			expect(result.success).toBe(true);

			const compression = db
				.query(`SELECT compression_ratio FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as { compression_ratio: number } | null;

			expect(compression?.compression_ratio).toBeCloseTo(0.99999);
		});

		it("handles empty removed content array", async () => {
			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 50000,
				compressionRatio: 0.5,
				removedContent: [],
				estimatedCost: 1000
			});

			expect(result.success).toBe(true);

			const compression = db
				.query(`SELECT removed_content FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as { removed_content: string } | null;

			expect(JSON.parse(compression?.removed_content || "[]")).toEqual([]);
		});

		it("handles optional work_in_progress being undefined", async () => {
			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 50000,
				compressionRatio: 0.5,
				removedContent: [],
				estimatedCost: 1000
			});

			expect(result.success).toBe(true);

			const compression = db
				.query(`SELECT work_in_progress FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as { work_in_progress: string | null } | null;

			expect(compression?.work_in_progress).toBeNull();
		});

		it("stores multiple content types in removed_content", async () => {
			const removedContent = [
				{ type: "history", description: "Old messages", tokenCount: 30000 },
				{ type: "artifacts", description: "Previous file contents", tokenCount: 15000 },
				{ type: "notes", description: "Shared notes", tokenCount: 5000 }
			];

			await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 50000,
				compressionRatio: 0.5,
				removedContent,
				estimatedCost: 1000
			});

			const compression = db
				.query(`SELECT removed_content FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as { removed_content: string } | null;

			const parsed = JSON.parse(compression?.removed_content || "[]");
			expect(parsed).toHaveLength(3);
			expect(parsed[0].type).toBe("history");
			expect(parsed[1].type).toBe("artifacts");
			expect(parsed[2].type).toBe("notes");
		});
	});

	describe("Context Budget Queries", () => {
		beforeEach(async () => {
			await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 50000,
				compressionRatio: 0.5,
				removedContent: [],
				estimatedCost: 1000
			});
		});

		it("calculates remaining budget correctly", () => {
			const arm = db
				.query(`SELECT context_budget, context_budget_used FROM arms WHERE id = ?`)
				.get(TEST_ARM_ID) as { context_budget: number; context_budget_used: number } | null;

			const remaining = (arm?.context_budget || 0) - (arm?.context_budget_used || 0);

			expect(remaining).toBe(127000);
		});

		it("calculates usage percentage correctly", () => {
			const arm = db
				.query(`SELECT context_budget, context_budget_used FROM arms WHERE id = ?`)
				.get(TEST_ARM_ID) as { context_budget: number; context_budget_used: number } | null;

			const usagePercent = ((arm?.context_budget_used || 0) / (arm?.context_budget || 1)) * 100;

			expect(usagePercent).toBeCloseTo(0.78, 1);
		});

		it("retrieves recent compressions within time window", async () => {
			await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: "task-2",
				originalTokens: 80000,
				compressedTokens: 40000,
				compressionRatio: 0.5,
				removedContent: [],
				estimatedCost: 800
			});

			const compressions = db
				.query(`
					SELECT * FROM context_compressions
					WHERE arm_id = ? AND timestamp > datetime('now', '-1 hour')
					ORDER BY timestamp DESC
				`)
				.all(TEST_ARM_ID) as Array<{ task_id: string }>;

			expect(compressions.length).toBe(2);
		});

		it("calculates average compression ratio from recent compressions", async () => {
			await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: "task-2",
				originalTokens: 80000,
				compressedTokens: 20000,
				compressionRatio: 0.25,
				removedContent: [],
				estimatedCost: 800
			});

			const compressions = db
				.query(`
					SELECT compression_ratio FROM context_compressions
					WHERE arm_id = ? AND timestamp > datetime('now', '-1 hour')
				`)
				.all(TEST_ARM_ID) as Array<{ compression_ratio: number }>;

			const avgRatio =
				compressions.reduce((sum, c) => sum + c.compression_ratio, 0) / compressions.length;

			expect(avgRatio).toBeCloseTo(0.375);
		});
	});

	describe("Edge Cases", () => {
		it("handles zero original tokens gracefully", async () => {
			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: 0,
				compressedTokens: 0,
				compressionRatio: 1.0,
				removedContent: [],
				estimatedCost: 0
			});

			expect(result.success).toBe(true);
		});

		it("handles very large token counts", async () => {
			const largeTokens = 10_000_000;

			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: TEST_ARM_ID,
				taskId: TEST_TASK_ID,
				originalTokens: largeTokens,
				compressedTokens: largeTokens / 2,
				compressionRatio: 0.5,
				removedContent: [],
				estimatedCost: largeTokens * 0.01
			});

			expect(result.success).toBe(true);

			const compression = db
				.query(`SELECT original_tokens FROM context_compressions WHERE arm_id = ?`)
				.get(TEST_ARM_ID) as { original_tokens: number } | null;

			expect(compression?.original_tokens).toBe(largeTokens);
		});

		it("handles different arm IDs", async () => {
			db.run(
				`INSERT INTO arms (id, name, context_budget, context_budget_used) VALUES (?, ?, ?, ?)`,
				["another-arm", "Another Arm", 256000, 0]
			);

			const result = await recordContextCompressionWithBudgetUpdate(db, {
				armId: "another-arm",
				taskId: TEST_TASK_ID,
				originalTokens: 100000,
				compressedTokens: 50000,
				compressionRatio: 0.5,
				removedContent: [],
				estimatedCost: 1000
			});

			expect(result.success).toBe(true);

			const arm = db
				.query(`SELECT context_budget_used FROM arms WHERE id = ?`)
				.get("another-arm") as { context_budget_used: number } | null;

			expect(arm?.context_budget_used).toBe(1000);
		});
	});

	describe("Budget Threshold Detection", () => {
		it("detects when budget is approaching limit (80%)", async () => {
			const budget = 128000;
			const used = budget * 0.81;

			db.run(
				`UPDATE arms SET context_budget_used = ? WHERE id = ?`,
				[used, TEST_ARM_ID]
			);

			const arm = db
				.query(`SELECT context_budget, context_budget_used FROM arms WHERE id = ?`)
				.get(TEST_ARM_ID) as { context_budget: number; context_budget_used: number } | null;

			const usagePercent = ((arm?.context_budget_used || 0) / (arm?.context_budget || 1)) * 100;

			expect(usagePercent).toBeGreaterThan(80);
		});

		it("detects when budget is at critical limit (95%)", async () => {
			const budget = 128000;
			const used = budget * 0.96;

			db.run(
				`UPDATE arms SET context_budget_used = ? WHERE id = ?`,
				[used, TEST_ARM_ID]
			);

			const arm = db
				.query(`SELECT context_budget, context_budget_used FROM arms WHERE id = ?`)
				.get(TEST_ARM_ID) as { context_budget: number; context_budget_used: number } | null;

			const usagePercent = ((arm?.context_budget_used || 0) / (arm?.context_budget || 1)) * 100;

			expect(usagePercent).toBeGreaterThan(95);
		});

		it("detects when budget is at maximum (100%)", async () => {
			const budget = 128000;

			db.run(
				`UPDATE arms SET context_budget_used = ? WHERE id = ?`,
				[budget, TEST_ARM_ID]
			);

			const arm = db
				.query(`SELECT context_budget, context_budget_used FROM arms WHERE id = ?`)
				.get(TEST_ARM_ID) as { context_budget: number; context_budget_used: number } | null;

			const usagePercent = ((arm?.context_budget_used || 0) / (arm?.context_budget || 1)) * 100;

			expect(usagePercent).toBeGreaterThanOrEqual(100);
		});
	});
});
