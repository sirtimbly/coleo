import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { initDatabase } from "../../db";
import { createTestEventStore } from "../../nats/in-memory-event-store";
import { writeThreadFixture } from "../../scripts/workbench-demo/thread-fixture-api";
import { normalizeMessagingQuery } from "../../workbench/messaging-query";
import { loadMessagingCollection } from "../messaging-collection";
import { formatErrorResponse } from "../middleware/error";
import { createWorkbenchInboxRoutes } from "../routes/workbench-inbox";

import type { Database } from "bun:sqlite";
import type { MessagingCollectionPage } from "../../workbench/messaging-collection";

describe("scoped Messaging collection", () => {
	let directory: string;
	let db: Database;
	beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "coleo-messaging-")); db = await initDatabase(":memory:"); });
	afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

	it("uses the existing endpoint for one scoped mail read and carries attached reply context", async () => {
		await writeThreadFixture(directory);
		const app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => { c.set("db", db); await next(); });
		app.onError((error, c) => formatErrorResponse(c, error));
		app.route("/inbox", createWorkbenchInboxRoutes({ coleoDir: directory }));
		const query = normalizeMessagingQuery({ scope: "mail", limit: 1 });
		const response = await app.request(`/inbox?query=${encodeURIComponent(JSON.stringify(query))}`);
		expect(response.status).toBe(200);
		const page = await response.json() as MessagingCollectionPage;
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.thread?.hierarchy.nodes).toHaveLength(6);
		expect(page.sources.map((source) => source.id)).toEqual(["mail"]);
		expect(page.summaries).toMatchObject({ total: 2, complete: true });
		expect(page.nextCursor).toBeTruthy();
	});

	it("traverses the full durable-source window, including filtered matches beyond a prefix", async () => {
		const time = "2026-10-01T12:00:00.000Z";
		db.transaction(() => {
			for (let i = 0; i < 530; i++) db.run(`INSERT INTO tasks
				(id,subject,description,status,priority,source_type,blocked_reason,created_at,updated_at)
				VALUES (?,?,'fixture','blocked','high','manual','waiting',?,?)`, [`task-${i}`, `Task ${i}`, time, time]);
		})();
		const store = createTestEventStore();
		const query = normalizeMessagingQuery({ facet: "all", limit: 25 });
		const ids: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await loadMessagingCollection(db, directory, query, cursor, { store });
			ids.push(...page.items.map((item) => item.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(ids).toHaveLength(530);
		expect(new Set(ids).size).toBe(530);
		const filtered = await loadMessagingCollection(db, directory, normalizeMessagingQuery({ facet: "all", search: "Task 3", limit: 200 }), undefined, { store });
		expect(filtered.items.map((item) => item.id)).toContain("task:task-3");
	});

	it("scans retained history beyond 5000 events, preserves Brain categories, and deduplicates source representations", async () => {
		const store = createTestEventStore();
		await store.publishEvent("coleo.events.brain.activity", { type: "poll_completed", timestamp: "2026-10-01T12:00:00Z",
			data: { actor: "brain", activityId: "older", pendingTasks: 2, activeArms: 3, durationMs: 1200 } });
		for (let i = 0; i < 5100; i++) await store.publishEvent("coleo.events.arm.noise", {
			type: "message.delta", timestamp: "2026-10-01T13:00:00Z", armId: "arm-fixture", data: {},
		});
		await store.publishEvent("coleo.events.task.blocked", { type: "task.blocked", timestamp: "2026-10-01T14:00:00Z",
			armId: "arm-fixture", data: { taskId: "target" } });
		const brain = await loadMessagingCollection(db, directory, normalizeMessagingQuery({ facet: "brain", brainCategory: "operations" }), undefined, { store });
		expect(brain.items).toHaveLength(1);
		expect(brain.items[0]).toMatchObject({ id: "activity:older", title: "Poll completed", summary: "2 pending tasks, 3 active arms in 1.2s" });
		const all = await loadMessagingCollection(db, directory, normalizeMessagingQuery({ facet: "all", search: "Task blocked" }), undefined, { store });
		expect(all.items).toHaveLength(1);
		expect(all.items[0]?.sourceId).toBe("events");
	});

	it("binds traversal to normalized query and retained sequence boundaries", async () => {
		const store = createTestEventStore();
		for (let i = 0; i < 3; i++) await store.publishEvent("coleo.events.brain.activity", { type: "poll_completed",
			timestamp: `2026-10-01T12:0${i}:00Z`, data: { actor: "brain", activityId: String(i) } });
		const query = normalizeMessagingQuery({ facet: "brain", limit: 1 });
		const first = await loadMessagingCollection(db, directory, query, undefined, { store });
		await store.publishEvent("coleo.events.brain.activity", { type: "poll_completed", timestamp: "2026-10-01T13:00:00Z", data: { actor: "brain", activityId: "new" } });
		const second = await loadMessagingCollection(db, directory, query, first.nextCursor!, { store });
		expect(second.items[0]?.id).toBe("activity:1");
		await expect(loadMessagingCollection(db, directory, normalizeMessagingQuery({ ...query, search: "different" }), first.nextCursor!, { store })).rejects.toThrow("Invalid Messaging cursor");
	});

	it("labels unavailable sources, retains healthy data, and separates a true empty result from failure", async () => {
		await writeThreadFixture(directory);
		const store = createTestEventStore();
		const query = normalizeMessagingQuery({ facet: "all" });
		const page = await loadMessagingCollection(db, directory, query, undefined, {
			store: { ...store, isInitialized: () => false } as typeof store,
		});
		expect(page.items.filter((item) => item.sourceId === "mail")).toHaveLength(2);
		expect(page.sources.filter((source) => source.status === "unavailable").map((source) => source.id)).toEqual(["activity", "events"]);
		expect(page.summaries.complete).toBe(false);
		expect(page.nextCursor).toBeNull();
		const empty = await loadMessagingCollection(db, directory, normalizeMessagingQuery({ facet: "all", search: "does-not-match" }), undefined, { store });
		expect(empty.items).toEqual([]);
		expect(empty.summaries).toMatchObject({ total: 0, complete: true });
	});

	it("bounds a stalled source and distinguishes unavailable mail from legitimate empty data", async () => {
		const query = normalizeMessagingQuery({ scope: "mail" });
		const page = await loadMessagingCollection(db, directory, query, undefined, {
			loadMail: async () => await new Promise(() => {}), sourceTimeoutMs: 10,
		});
		expect(page.sources[0]).toMatchObject({ id: "mail", status: "unavailable", complete: false });
		expect(page.sources[0]?.error?.message).toContain("timed out");
		expect(page.summaries.complete).toBe(false);
	});
});
