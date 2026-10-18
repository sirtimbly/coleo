import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createTestEventStore, resetEventStore, setEventStore } from "../../nats/jetstream";
import { formatErrorResponse } from "../middleware/error";
import { createWorkbenchInboxRoutes } from "../routes/workbench-inbox";

describe("single inbox record detail", () => {
	let db: Database;
	let store: ReturnType<typeof createTestEventStore>;
	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`CREATE TABLE workbench_profiles (id TEXT PRIMARY KEY);
		INSERT INTO workbench_profiles VALUES ('local');
		CREATE TABLE tasks (id TEXT PRIMARY KEY, subject TEXT, description TEXT, status TEXT, updated_at TEXT);
		INSERT INTO tasks VALUES ('old-task', 'Old completed task', 'Still addressable', 'completed', '2020-01-01');
		CREATE TABLE workbench_attention (profile_id TEXT, item_key TEXT, seen_at TEXT, read_at TEXT,
		archived_at TEXT, snoozed_until TEXT, resolved_at TEXT, assigned_to TEXT, requires_action INTEGER, updated_at TEXT);`);
		store = createTestEventStore();
		setEventStore(store);
	});
	afterEach(() => { db.close(); resetEventStore(); });
	function app() {
		const app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => { c.set("db", db); await next(); });
		app.onError((error, c) => formatErrorResponse(c, error));
		app.route("/inbox", createWorkbenchInboxRoutes());
		return app;
	}
	it("loads a record outside the inbox filters without accessing unrelated source tables", async () => {
		const response = await app().request("/inbox/records/task%3Aold-task");
		expect(response.status).toBe(200);
		expect((await response.json()).item).toMatchObject({ title: "Old completed task", requiresAction: false });
	});
	it("returns a terminal missing state, not an empty collection", async () => {
		expect((await app().request("/inbox/records/task%3Amissing")).status).toBe(404);
	});
	it("reads exactly the selected stream event without a history scan", async () => {
		await store.publishEvent("coleo.events.brain.poll", {
			type: "poll_completed", timestamp: "2026-09-18T12:00:00Z", data: { actor: "brain", activityId: "old-uuid", apiKey: "secret" },
		});
		const scan = spyOn(store, "queryEvents");
		const response = await app().request("/inbox/events/activity%3Aold-uuid?sequence=1");
		expect(response.status).toBe(200);
		expect(scan).not.toHaveBeenCalled();
		expect((await response.json()).event).toMatchObject({ sequence: 1, data: { apiKey: "[REDACTED]" } });
	});
	it("does not substitute another event when the identity or sequence is wrong", async () => {
		await store.publishEvent("coleo.events.brain.poll", { type: "poll_completed", timestamp: "2026-09-18T12:00:00Z", data: {} });
		expect((await app().request("/inbox/events/activity%3Awrong?sequence=1")).status).toBe(404);
		expect((await app().request("/inbox/events/activity%3Aevent-1?sequence=-1")).status).toBe(400);
	});
	it("restores legacy event links without sequence parameters", async () => {
		await store.publishEvent("coleo.events.brain.poll", { type: "poll_completed", timestamp: "2026-09-18T12:00:00Z", data: { activityId: "legacy-id" } });
		expect((await app().request("/inbox/events/activity%3Alegacy-id")).status).toBe(200);
	});
});
