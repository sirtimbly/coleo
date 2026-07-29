import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { createArmsRoutes } from "../routes/arms";

function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE arms (
			id TEXT PRIMARY KEY,
			current_context_used INTEGER NOT NULL DEFAULT 0,
			context_budget INTEGER NOT NULL DEFAULT 100000,
			total_tokens INTEGER DEFAULT 0,
			total_cost REAL DEFAULT 0,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE arm_metric_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			arm_id TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			context_used INTEGER NOT NULL,
			context_budget INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			total_cost REAL NOT NULL
		);

		CREATE TABLE arm_message_metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			arm_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			session_id TEXT,
			timestamp TEXT NOT NULL,
			context_used INTEGER NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			reasoning_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			cost REAL NOT NULL,
			UNIQUE (arm_id, message_id)
		);
	`);

	const now = new Date();
	const nowIso = now.toISOString();
	const older = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
	const newer = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
	db.run(
		"INSERT INTO arms (id, current_context_used, context_budget, total_tokens, total_cost, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		["arm-1", 321, 50000, 1_000, 2.5, nowIso],
	);

	db.run(
		"INSERT INTO arm_metric_history (arm_id, timestamp, context_used, context_budget, total_tokens, total_cost) VALUES (?, ?, ?, ?, ?, ?)",
		["arm-1", older, 100, 50000, 100, 0.5],
	);
	db.run(
		"INSERT INTO arm_metric_history (arm_id, timestamp, context_used, context_budget, total_tokens, total_cost) VALUES (?, ?, ?, ?, ?, ?)",
		["arm-1", newer, 200, 50000, 200, 1.0],
	);
	db.run(
		"INSERT INTO arm_message_metrics (arm_id, message_id, timestamp, context_used, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		["arm-1", "message-1", older, 100, 10, 20, 2, 4, 1, 0.25],
	);
	db.run(
		"INSERT INTO arm_message_metrics (arm_id, message_id, timestamp, context_used, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		["arm-1", "message-2", newer, 200, 8, 12, 4, 6, 2, 0.50],
	);

	return db;
}

describe("arms metric history routes", () => {
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;

	beforeEach(() => {
		db = createTestDb();
		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			return next();
		});
		app.route("/api/arms", createArmsRoutes());
	});

	afterEach(() => {
		db.close();
	});

	it("returns context history ordered and windowed", async () => {
		const response = await app.request(
			"http://coleo.test/api/arms/arm-1/context-history?windowMs=1200000",
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			armId: string;
			windowMs: number;
			samples: Array<{ timestamp: string; used: number; budget: number }>;
		};
		expect(body.armId).toBe("arm-1");
		expect(body.samples).toHaveLength(2);
		expect(body.samples[0]!).toMatchObject({ used: 100, budget: 50000 });
		expect(body.samples[1]!).toMatchObject({ used: 200, budget: 50000 });
		expect(body.samples[0]!.timestamp < body.samples[1]!.timestamp).toBe(true);
		expect(body.windowMs).toBe(1200000);
	});

	it("falls back to current arm row when context snapshots are missing", async () => {
		db.run("DELETE FROM arm_metric_history");
		const current = db.query("SELECT updated_at as updatedAt FROM arms WHERE id = 'arm-1'").get() as {
			updatedAt: string;
		};
		const response = await app.request("http://coleo.test/api/arms/arm-1/context-history");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			armId: string;
			samples: Array<{ timestamp: string; used: number; budget: number }>;
		};
		expect(body.armId).toBe("arm-1");
		expect(body.samples).toHaveLength(1);
		expect(body.samples[0]!).toMatchObject({ used: 321, budget: 50000, timestamp: current.updatedAt });
	});

	it("returns message-level cost history ordered and tokenized", async () => {
		const response = await app.request(
			"http://coleo.test/api/arms/arm-1/cost-history?windowMs=1200000",
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			armId: string;
			samples: Array<{
				timestamp: string;
				cost: number;
				tokens: number;
				messageId: string;
			}>;
		};
		expect(body.armId).toBe("arm-1");
		expect(body.samples).toHaveLength(2);
		expect(body.samples[0]!).toMatchObject({ messageId: "message-1", cost: 0.25, tokens: 37 });
		expect(body.samples[1]!).toMatchObject({ messageId: "message-2", cost: 0.5, tokens: 32 });
		expect(new Date(body.samples[0]!.timestamp).getTime() < new Date(body.samples[1]!.timestamp).getTime()).toBe(true);
	});
});
