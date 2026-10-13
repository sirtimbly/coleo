import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { initDatabase } from "../../db";
import { formatErrorResponse } from "../middleware/error";
import { createWorkbenchInboxRoutes } from "../routes/workbench-inbox";

import type { Database } from "bun:sqlite";
import type { WorkbenchInboxRecord } from "../../types/adaptive-cards";

const TIMESTAMP = "2026-10-01T12:00:00.000Z";
interface InboxPage { items: WorkbenchInboxRecord[]; nextCursor?: string }

describe("durable Inbox keyset traversal", () => {
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;
	beforeEach(async () => {
		db = await initDatabase(":memory:");
		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => { c.set("db", db); await next(); });
		app.onError((error, c) => formatErrorResponse(c, error));
		app.route("/inbox", createWorkbenchInboxRoutes());
	});
	afterEach(() => db.close());

	function addTask(id: string, timestamp = TIMESTAMP) {
		db.run(`INSERT INTO tasks (id, subject, description, status, priority, source_type, blocked_reason, created_at, updated_at)
			VALUES (?, ?, 'Fixture', 'blocked', 'high', 'manual', 'Fixture decision required', ?, ?)`, [id, id, timestamp, timestamp]);
	}

	function hide(itemKey: string, mode: "archive" | "snooze") {
		db.run(`INSERT INTO workbench_attention (profile_id, item_key, archived_at, snoozed_until, updated_at)
			VALUES ('local', ?, ?, ?, ?)`, [itemKey, mode === "archive" ? TIMESTAMP : null,
			mode === "snooze" ? "2999-01-01T00:00:00.000Z" : null, TIMESTAMP]);
	}

	async function read(params: URLSearchParams = new URLSearchParams()): Promise<InboxPage> {
		const response = await app.request(`/inbox?${params}`);
		expect(response.status).toBe(200);
		return await response.json() as InboxPage;
	}

	async function traverse(limit: number): Promise<string[]> {
		const keys: string[] = [];
		let cursor: string | undefined;
		for (let count = 0; count < 1000; count++) {
			const params = new URLSearchParams({ limit: String(limit) });
			if (cursor) params.set("cursor", cursor);
			const page = await read(params);
			keys.push(...page.items.map((item) => item.itemKey));
			if (!page.nextCursor) return keys;
			expect(page.items.length).toBeGreaterThan(0);
			cursor = page.nextCursor;
		}
		throw new Error("Traversal did not terminate");
	}

	it("traverses beyond the old source prefix without duplicates or skipped records", async () => {
		db.transaction(() => {
			for (let i = 0; i < 525; i++) addTask(`task-${String(i).padStart(4, "0")}`);
			for (let i = 0; i < 7; i++) db.run(`INSERT INTO status_reports (id, task_id, arm_id, status, summary, created_at)
				VALUES (?, 'task-0000', 'arm-fixture', 'needs_review', 'Review fixture', ?)`, [`report-${i}`, TIMESTAMP]);
		})();
		const keys = await traverse(25);
		expect(keys).toHaveLength(532);
		expect(new Set(keys).size).toBe(532);
		expect(keys).toContain("task:task-0000");
		expect(keys).toContain("status:report-0");
	});

	it("applies archive and snooze visibility before source limits", async () => {
		db.transaction(() => {
			for (let i = 0; i < 450; i++) {
				const id = `z-hidden-${String(i).padStart(4, "0")}`;
				addTask(id);
				hide(`task:${id}`, i % 2 === 0 ? "archive" : "snooze");
			}
			addTask("a-visible");
		})();
		expect((await read(new URLSearchParams({ limit: "10" }))).items.map((item) => item.itemKey))
			.toEqual(["task:a-visible"]);
	});

	it("orders punctuation-heavy tie breakers consistently in SQL and TypeScript", async () => {
		for (const id of ["a-1", "a:1", "a_1", "aA", "\ue000", "😀"]) addTask(id);
		expect(await traverse(1)).toEqual(["task:😀", "task:\ue000", "task:a_1", "task:aA", "task:a:1", "task:a-1"]);
	});

	it("normalizes existing SQL/offset timestamps before ordering and paging", async () => {
		addTask("older", TIMESTAMP);
		addTask("newer", "2026-10-01 13:00:00");
		addTask("oldest", "2026-10-01T13:00:00+02:00");
		expect(await traverse(1)).toEqual(["task:newer", "task:older", "task:oldest"]);
	});

	it("does not advertise another page when the last page exactly fills the limit", async () => {
		addTask("one"); addTask("two");
		const page = await read(new URLSearchParams({ limit: "2" }));
		expect(page.items).toHaveLength(2);
		expect(page.nextCursor).toBeUndefined();
	});

	it("binds cursors to profile and projection, while allowing a different page size", async () => {
		addTask("one"); addTask("two");
		db.run(`INSERT INTO workbench_profiles (id, name, created_at, updated_at) VALUES ('second', 'Second', ?, ?)`, [TIMESTAMP, TIMESTAMP]);
		const first = await read(new URLSearchParams({ limit: "1" }));
		expect(first.nextCursor).toBeDefined();
		const otherProfile = await app.request(`/inbox?profileId=second&cursor=${first.nextCursor}`);
		expect(otherProfile.status).toBe(400);
		expect((await read(new URLSearchParams({ limit: "2", cursor: first.nextCursor! }))).items).toHaveLength(1);
		for (const value of ["not-a-cursor", [TIMESTAMP, "task:one"],
			{ schemaVersion: 2, projection: "durable-inbox", profileId: "local", before: { timestamp: TIMESTAMP, id: "task:one" } },
			{ schemaVersion: 1, projection: "other", profileId: "local", before: { timestamp: TIMESTAMP, id: "task:one" } },
		]) {
			const cursor = typeof value === "string" ? value : Buffer.from(JSON.stringify(value)).toString("base64url");
			expect((await app.request(`/inbox?cursor=${cursor}`)).status).toBe(400);
		}
	});

	it("rejects invalid page sizes rather than causing SQL errors or silently empty data", async () => {
		for (const limit of ["0", "-1", "1.5", "NaN", "Infinity", "garbage", ""]) {
			expect((await app.request(`/inbox?limit=${limit}`)).status).toBe(400);
		}
		addTask("one");
		expect((await read(new URLSearchParams({ limit: "1000" }))).items).toHaveLength(1);
	});

	it("applies the same paging and visibility rules to swarm recommendations", async () => {
		db.run(`INSERT INTO brain_swarm_evaluations (id, mode, snapshot, result, created_at)
			VALUES ('evaluation', 'shadow', '{}', '{}', ?)`, [TIMESTAMP]);
		const proposal = JSON.stringify({ action: "comment_task", targetType: "task", targetId: "fixture",
			expectedVersion: TIMESTAMP, reason: "new_finding", evidenceId: "fixture", evidenceAt: TIMESTAMP,
			evidenceText: "Fixture evidence", probability: 0.9, parameters: {} });
		for (let i = 0; i < 15; i++) {
			const id = `recommendation-${String(i).padStart(2, "0")}`;
			db.run(`INSERT INTO brain_swarm_recommendations (id, evaluation_id, proposal, created_at)
				VALUES (?, 'evaluation', ?, ?)`, [id, proposal, TIMESTAMP]);
			if (i >= 10) hide(`swarm:${id}`, "archive");
		}
		const keys = await traverse(2);
		expect(keys).toHaveLength(10);
		expect(new Set(keys).size).toBe(10);
		expect(keys.at(-1)).toBe("swarm:recommendation-00");
	});
});
