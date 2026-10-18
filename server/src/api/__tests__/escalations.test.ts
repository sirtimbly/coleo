import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createEscalationRoutes } from "../routes/escalations";

describe("escalation tracking API", () => {
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE escalation_tracking (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id TEXT NOT NULL,
				bug_id TEXT NOT NULL,
				escalation_level INTEGER NOT NULL DEFAULT 0,
				last_escalated_at TEXT,
				notified_human INTEGER DEFAULT 0,
				auto_assigned_bug INTEGER DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});
		app.route("/api/escalations", createEscalationRoutes());
	});

	afterEach(() => {
		db.close();
	});

	it("persists and updates one escalation per task-bug pair", async () => {
		const created = await app.request("/api/escalations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				taskId: "task-1",
				bugId: "bug-1",
				escalationLevel: 1,
				notifiedHuman: true,
			}),
		});
		expect(created.status).toBe(200);

		const updated = await app.request("/api/escalations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				taskId: "task-1",
				bugId: "bug-1",
				escalationLevel: 2,
				autoAssignedBug: true,
			}),
		});
		expect(updated.status).toBe(200);

		const response = await app.request("/api/escalations");
		const body = (await response.json()) as {
			escalations: Array<{
				id: number;
				taskId: string;
				bugId: string;
				escalationLevel: number;
				lastEscalatedAt: string | null;
				notifiedHuman: boolean;
				autoAssignedBug: boolean;
				createdAt: string;
				updatedAt: string;
			}>;
		};

		expect(body.escalations).toEqual([
			{
				id: 1,
				taskId: "task-1",
				bugId: "bug-1",
				escalationLevel: 2,
				lastEscalatedAt: expect.any(String),
				notifiedHuman: true,
				autoAssignedBug: true,
				createdAt: expect.any(String),
				updatedAt: expect.any(String),
			},
		]);
	});
});
