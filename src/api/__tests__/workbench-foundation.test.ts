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

	it("persists attention transitions independently from source events", async () => {
		const app = createTestApp();
		const itemKey = "event:task.blocked:task-test";
		const readAt = new Date().toISOString();
		const update = await app.request(`/workbench/attention/${encodeURIComponent(itemKey)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				profileId: "local",
				seenAt: readAt,
				readAt,
				requiresAction: true,
			}),
		});
		expect(update.status).toBe(200);
		expect((await update.json() as {
			attention: { itemKey: string; requiresAction: boolean };
		}).attention).toMatchObject({ itemKey, requiresAction: true });

		const resolve = await app.request("/workbench/attention/bulk", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				profileId: "local",
				itemKeys: [itemKey],
				action: "resolve",
			}),
		});
		expect(resolve.status).toBe(200);

		const listed = await app.request("/workbench/attention?profileId=local&includeArchived=true");
		const attention = (await listed.json() as {
			attention: Array<{ itemKey: string; resolvedAt?: string; requiresAction: boolean }>;
		}).attention;
		expect(attention).toHaveLength(1);
		expect(attention[0]?.itemKey).toBe(itemKey);
		expect(attention[0]?.resolvedAt).toBeString();
		expect(attention[0]?.requiresAction).toBe(false);
	});

	it("allowlists card actions and updates scalar resource fields", async () => {
		const app = createTestApp();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
			   id, subject, description, status, priority, source_type, created_at, updated_at
			 ) VALUES ('card-task', 'Before', 'Before detail', 'draft', 'normal', 'manual', ?, ?)`,
			[now, now],
		);

		const actionBody = {
			envelopeId: "edit:task:card-task",
			template: { id: "workbench.resource-editor", version: 2 },
			actionId: "save-resource",
			verb: "task.update",
			resource: { kind: "task", id: "card-task" },
			inputs: {
				actionId: "save-resource",
				title: "After",
				description: "After detail",
				priority: "high",
				dueDate: "2026-08-20",
				progress: "45",
				phase: "Phase 2",
				domain: "frontend",
			},
			clientActionId: "action-test",
		};
		const action = await app.request("/workbench/cards/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(actionBody),
		});
		expect(action.status).toBe(200);
		expect((await action.json() as {
			result: { ok: boolean; clientActionId: string };
		}).result).toMatchObject({ ok: true, clientActionId: "action-test" });
		expect(db.query(
			`SELECT subject, description, priority, due_date AS dueDate,
			        progress, phase, domain
			 FROM tasks WHERE id = ?`,
		).get("card-task")).toEqual({
			subject: "After",
			description: "After detail",
			priority: "high",
			dueDate: "2026-08-20",
			progress: 45,
			phase: "Phase 2",
			domain: "frontend",
		});
		const duplicate = await app.request("/workbench/cards/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(actionBody),
		});
		expect(duplicate.status).toBe(200);
		expect((db.query(
			"SELECT COUNT(*) AS count FROM workbench_card_action_receipts WHERE client_action_id = ?",
		).get("action-test") as { count: number }).count).toBe(1);
		expect((db.query(
			"SELECT COUNT(*) AS count FROM workbench_card_action_audit WHERE client_action_id = ?",
		).get("action-test") as { count: number }).count).toBe(1);

		const stale = await app.request("/workbench/cards/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...actionBody,
				clientActionId: "action-stale",
				expectedResourceVersion: "2020-01-01T00:00:00.000Z",
			}),
		});
		expect(stale.status).toBe(409);

		const rejected = await app.request("/workbench/cards/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				envelopeId: "event:test",
				template: { id: "workbench.event", version: 1 },
				actionId: "save-resource",
				verb: "task.update",
				resource: { kind: "task", id: "card-task" },
				inputs: { title: "Not allowed" },
				clientActionId: "action-rejected",
			}),
		});
		expect(rejected.status).toBe(400);
	});

	it("restores persisted card panels by opaque instance identity", async () => {
		const app = createTestApp();
		const envelope = {
			id: "event:test",
			template: { id: "workbench.event", version: 1 },
			schemaVersion: "1.5",
			presentation: { surface: "panel", title: "Test event" },
			data: { title: "Test event", summary: "Persistent card" },
			createdAt: new Date().toISOString(),
		};
		const created = await app.request("/workbench/cards/instances", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ profileId: "local", envelope }),
		});
		expect(created.status).toBe(201);
		const instance = (await created.json() as { instance: { id: string } }).instance;
		expect(instance.id).toBeString();

		const restored = await app.request(`/workbench/cards/instances/${instance.id}`);
		expect(restored.status).toBe(200);
		expect((await restored.json() as {
			instance: { envelope: { id: string; data: { title: string } } };
		}).instance.envelope).toMatchObject({
			id: "event:test",
			data: { title: "Test event" },
		});
	});

	it("returns a cursor-ready unified attention inbox", async () => {
		const app = createTestApp();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
			   id, subject, description, status, priority, source_type, blocked_reason,
			   created_at, updated_at
			 ) VALUES (
			   'inbox-task', 'Blocked task', 'Waiting on a decision', 'blocked',
			   'high', 'manual', 'Human decision required', ?, ?
			 )`,
			[now, now],
		);
		db.run(
			`INSERT INTO status_reports (
			   id, task_id, arm_id, status, summary, created_at
			 ) VALUES ('inbox-report', 'inbox-task', 'arm-test', 'needs_review', 'Review requested', ?)`,
			[now],
		);

		const response = await app.request("/workbench/inbox?profileId=local&limit=1");
		expect(response.status).toBe(200);
		const page = await response.json() as {
			items: Array<{ itemKey: string; requiresAction: boolean }>;
			nextCursor?: string;
		};
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.requiresAction).toBe(true);
		expect(page.nextCursor).toBeString();

		const next = await app.request(
			`/workbench/inbox?profileId=local&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
		);
		expect(next.status).toBe(200);
		expect((await next.json() as { items: Array<{ itemKey: string }> }).items).toHaveLength(1);
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
