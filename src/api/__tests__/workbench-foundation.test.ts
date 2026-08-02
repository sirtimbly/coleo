/**
 * Regression coverage for the workbench persistence and implicit-run model.
 *
 * These tests use the complete migration chain so they protect new installs and
 * upgrades from losing portable UI state or creating runs before work is
 * actually claimed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

import { initDatabase } from "../../db";
import { formatErrorResponse } from "../middleware/error";
import { createWorkbenchRoutes } from "../routes/workbench";

import type { Database } from "bun:sqlite";

describe("workbench foundation", () => {
	let directory: string;
	let db: Database;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "coleo-workbench-test-"));
		db = await initDatabase(join(directory, "state.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});

	function createTestApp() {
		const app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});
		app.onError((error, c) => formatErrorResponse(c, error));
		app.route("/workbench", createWorkbenchRoutes());
		return app;
	}

	it("persists and exports profile-owned views and layouts", async () => {
		const app = createTestApp();
		const bootstrap = await app.request("/workbench/bootstrap?profileId=local");
		expect(bootstrap.status).toBe(200);
		expect((await bootstrap.json() as { profile: { id: string } }).profile.id).toBe("local");

		const view = await app.request("/workbench/views", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "task-sheet-test",
				profileId: "local",
				key: "tasks-sheet",
				name: "Task sheet",
				kind: "sheet",
				resourceKind: "task",
				query: { resourceKinds: ["task"] },
				preferences: {
					columns: [{ id: "subject", visible: true, order: 0, width: 320 }],
				},
				shared: true,
			}),
		});
		expect(view.status).toBe(201);

		const layout = await app.request("/workbench/layouts/current:local", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				profileId: "local",
				name: "Current workspace",
				layout: { root: { type: "stack", content: [] } },
				isDefault: true,
			}),
		});
		expect(layout.status).toBe(200);

		const exported = await app.request("/workbench/profiles/local/export");
		const bundle = (await exported.json() as {
			bundle: { views: Array<{ key: string }>; layouts: unknown[] };
		}).bundle;
		expect(bundle.views).toHaveLength(1);
		expect(bundle.views[0]?.key).toBe("tasks-sheet");
		expect(bundle.layouts).toHaveLength(1);
	});

	it("allows the same stable view key per profile", async () => {
		const app = createTestApp();
		const profileResponse = await app.request("/workbench/profiles", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "second", name: "Second profile" }),
		});
		expect(profileResponse.status).toBe(201);

		for (const [id, profileId] of [["local-view", "local"], ["second-view", "second"]] as const) {
			const response = await app.request("/workbench/views", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id,
					profileId,
					key: "tasks-sheet",
					name: "Tasks",
					kind: "sheet",
					query: {},
					preferences: {},
				}),
			});
			expect(response.status).toBe(201);
		}

		expect((db.query(
			"SELECT COUNT(*) AS count FROM workbench_views WHERE view_key = 'tasks-sheet'",
		).get() as { count: number }).count).toBe(2);
	});

	it("starts a run only when an Arm claims work", () => {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO arms (id, name, domain, harness, status, created_at, updated_at)
			 VALUES ('arm-test', 'Test Arm', 'frontend', 'opencode-api', 'idle', ?, ?)`,
			[now, now],
		);
		db.run(
			`INSERT INTO tasks (
			   id, subject, description, status, priority, source_type, created_at, updated_at
			 ) VALUES (
			   'task-test', 'Claim me', 'Description', 'pending', 'normal', 'manual', ?, ?
			 )`,
			[now, now],
		);

		expect((db.query("SELECT COUNT(*) AS count FROM arm_runs").get() as { count: number }).count).toBe(0);

		db.run(
			`UPDATE tasks
			 SET assigned_to = 'arm-test', status = 'claimed', claimed_at = ?, updated_at = ?
			 WHERE id = 'task-test'`,
			[now, now],
		);
		const claimed = db.query(
			"SELECT status, ended_at AS endedAt FROM arm_runs WHERE work_id = 'task-test'",
		).get() as { status: string; endedAt: string | null };
		expect(claimed.status).toBe("claimed");
		expect(claimed.endedAt).toBeNull();

		db.run(
			"UPDATE tasks SET status = 'blocked', blocked_reason = 'Waiting for input', updated_at = ? WHERE id = 'task-test'",
			[now],
		);
		const blocked = db.query(
			"SELECT status, ended_at AS endedAt FROM arm_runs WHERE work_id = 'task-test'",
		).get() as { status: string; endedAt: string | null };
		expect(blocked.status).toBe("blocked");
		expect(blocked.endedAt).toBeNull();

		db.run(
			"UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = 'task-test'",
			[now, now],
		);
		const completed = db.query(
			"SELECT status, ended_at AS endedAt FROM arm_runs WHERE work_id = 'task-test'",
		).get() as { status: string; endedAt: string | null };
		expect(completed.status).toBe("completed");
		expect(completed.endedAt).toBe(now);
	});
});
