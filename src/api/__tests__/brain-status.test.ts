import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import {
	detectBrainModelAccessIssue,
	serializeBrainModelAccessIssue,
} from "../../brain/model-access";
import { createBrainRoutes } from "../routes/brain";

describe("Brain status API", () => {
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE brain_state (
				id INTEGER PRIMARY KEY,
				status TEXT NOT NULL,
				poll_interval_ms INTEGER NOT NULL,
				started_at TEXT,
				last_poll_at TEXT,
				pending_tasks INTEGER NOT NULL,
				completed_today INTEGER NOT NULL,
				completed_task_count INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			);
			INSERT INTO brain_state (
				id, status, poll_interval_ms, pending_tasks, completed_today,
				completed_task_count, updated_at
			) VALUES (1, 'running', 30000, 2, 1, 1, '2026-08-04T12:00:00.000Z');

			CREATE TABLE arms (id TEXT PRIMARY KEY, status TEXT NOT NULL);
			CREATE TABLE infrastructure_health (
				component TEXT PRIMARY KEY,
				healthy INTEGER NOT NULL,
				optional INTEGER NOT NULL,
				error TEXT,
				last_check TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);

		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});
		app.route("/api/brain", createBrainRoutes());
	});

	afterEach(() => {
		db.close();
	});

	it("reports insufficient credits as a plan-evaluation block without changing runtime status", async () => {
		const issue = detectBrainModelAccessIssue(
			429,
			'{"error":{"message":"You have no credits remaining. Add credits to continue."}}',
			"openai",
		);
		expect(issue).not.toBeNull();
		if (!issue) return;

		db.run(
			`INSERT INTO infrastructure_health
				(component, healthy, optional, error, last_check, updated_at)
			 VALUES (?, 0, 0, ?, ?, ?)`,
			[
				"brain_model_api",
				serializeBrainModelAccessIssue(issue),
				"2026-08-04T12:27:26.000Z",
				"2026-08-04T12:27:26.000Z",
			],
		);

		const response = await app.request("/api/brain/status");
		const body = await response.json() as {
			brain: {
				status: string;
				modelAccess: {
					status: string;
					issueCode: string;
					actionUrl: string;
				};
			};
		};

		expect(response.status).toBe(200);
		expect(body.brain.status).toBe("running");
		expect(body.brain.modelAccess).toMatchObject({
			status: "blocked",
			issueCode: "insufficient_credits",
		});
		expect(body.brain.modelAccess.actionUrl).toContain("platform.openai.com");

		const recovered = await app.request("/api/brain/internal/infrastructure-health", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				components: [
					{
						component: "brain_model_api",
						healthy: true,
						optional: false,
					},
				],
			}),
		});
		expect(recovered.status).toBe(200);

		const recoveredStatus = await app.request("/api/brain/status");
		const recoveredBody = await recoveredStatus.json() as {
			brain: { status: string; modelAccess: { status: string; issueCode: string | null } };
		};
		expect(recoveredBody.brain.status).toBe("running");
		expect(recoveredBody.brain.modelAccess).toMatchObject({
			status: "available",
			issueCode: null,
		});
	});
});
