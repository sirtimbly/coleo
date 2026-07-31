import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initDatabase } from "../index";

describe("database migrations", () => {
	const testDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("keeps a stable database instance id until the database is recreated", async () => {
		const dir = join(tmpdir(), `coleo-database-instance-${crypto.randomUUID()}`);
		testDirs.push(dir);
		const dbPath = join(dir, "coleo.db");
		const first = await initDatabase(dbPath);
		const firstId = first.query("SELECT value FROM config WHERE key = 'database_instance_id'").get() as {
			value: string;
		};
		first.close();

		const reopened = await initDatabase(dbPath);
		const reopenedId = reopened.query("SELECT value FROM config WHERE key = 'database_instance_id'").get() as {
			value: string;
		};
		reopened.close();
		expect(reopenedId.value).toBe(firstId.value);

		await rm(dbPath, { force: true });
		const recreated = await initDatabase(dbPath);
		const recreatedId = recreated.query("SELECT value FROM config WHERE key = 'database_instance_id'").get() as {
			value: string;
		};
		recreated.close();
		expect(recreatedId.value).not.toBe(firstId.value);
	});

	it("adds a durable planning gate flag to arms", async () => {
		const dir = join(tmpdir(), `coleo-arm-planning-gate-${crypto.randomUUID()}`);
		testDirs.push(dir);
		const db = await initDatabase(join(dir, "coleo.db"));
		const columns = db.query("PRAGMA table_info(arms)").all() as Array<{
			name: string;
			dflt_value: string | null;
		}>;

		expect(columns.find((column) => column.name === "planning_blocked")?.dflt_value).toBe("0");
		db.close();
	});

	it("normalizes legacy task keys to SQLite-sortable queue order", async () => {
		const dir = join(tmpdir(), `coleo-migration-${crypto.randomUUID()}`);
		testDirs.push(dir);
		const dbPath = join(dir, "coleo.db");
		const legacyAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		const db = await initDatabase(dbPath);

		for (let index = 0; index < 30; index++) {
			const id = `task-${String(index + 1).padStart(2, "0")}`;
			const timestamp = new Date(index).toISOString();
			db.run(
				`INSERT INTO tasks (id, subject, description, status, sort_order, order_key, created_at, updated_at)
				 VALUES (?, ?, '', 'pending', ?, ?, ?, ?)`,
				[id, id, index + 1, legacyAlphabet[index]!, timestamp, timestamp],
			);
		}
		db.run("DELETE FROM _migrations WHERE name = '059_normalize_task_order_keys'");
		db.close();

		const migrated = await initDatabase(dbPath);
		const rows = migrated
			.query("SELECT id, order_key FROM tasks WHERE status = 'pending' ORDER BY order_key ASC")
			.all() as Array<{ id: string; order_key: string }>;
		migrated.close();

		expect(rows.map((row) => row.id)).toEqual(
			Array.from({ length: 30 }, (_, index) => `task-${String(index + 1).padStart(2, "0")}`),
		);
		expect(rows[0]?.order_key).toBe("a0000000001");
		expect(rows[29]?.order_key).toBe("a0000000030");
	});

	it("backfills entity status history from lifecycle timestamps", async () => {
		const dir = join(tmpdir(), `coleo-migration-${crypto.randomUUID()}`);
		testDirs.push(dir);
		const dbPath = join(dir, "coleo.db");
		const db = await initDatabase(dbPath);
		const createdAt = "2026-07-01T00:00:00.000Z";
		const updatedAt = "2026-07-20T00:00:00.000Z";
		const lifecycleTimes = {
			claimed: "2026-07-02T00:00:00.000Z",
			inProgress: "2026-07-03T00:00:00.000Z",
			blocked: "2026-07-04T00:00:00.000Z",
			completed: "2026-07-05T00:00:00.000Z",
			resolved: "2026-07-06T00:00:00.000Z",
		};

		db.run(
			`INSERT INTO tasks (id, subject, description, status, created_at, updated_at, claimed_at)
			 VALUES ('task-claimed', 'Claimed', '', 'claimed', ?, ?, ?)`,
			[createdAt, updatedAt, lifecycleTimes.claimed],
		);
		db.run(
			`INSERT INTO tasks (id, subject, description, status, created_at, updated_at, claimed_at, started_at)
			 VALUES ('task-progress', 'In progress', '', 'in_progress', ?, ?, ?, ?)`,
			[createdAt, updatedAt, lifecycleTimes.claimed, lifecycleTimes.inProgress],
		);
		db.run(
			`INSERT INTO tasks (
				id, subject, description, status, created_at, updated_at, blocked_at, blocked_reason, blocked_category
			) VALUES ('task-blocked', 'Blocked', '', 'blocked', ?, ?, ?, 'Waiting', 'dependency')`,
			[createdAt, updatedAt, lifecycleTimes.blocked],
		);
		db.run(
			`INSERT INTO tasks (id, subject, description, status, created_at, updated_at, completed_at)
			 VALUES ('task-completed', 'Completed', '', 'completed', ?, ?, ?)`,
			[createdAt, updatedAt, lifecycleTimes.completed],
		);
		db.run(
			`INSERT INTO bugs (id, title, description, source, status, created_at, updated_at, resolved_at)
			 VALUES ('bug-resolved', 'Resolved', '', 'human_reported', 'resolved', ?, ?, ?)`,
			[createdAt, updatedAt, lifecycleTimes.resolved],
		);
		db.run("DELETE FROM entity_status_history");
		db.run("DELETE FROM _migrations WHERE name = '063_entity_status_history'");
		db.close();

		const migrated = await initDatabase(dbPath);
		const changedAtByEntity = Object.fromEntries(
			(migrated.query(
				`SELECT entity_id, changed_at FROM entity_status_history
				 WHERE status NOT IN ('pending', 'open')`,
			).all() as Array<{ entity_id: string; changed_at: string }>).map((row) => [row.entity_id, row.changed_at]),
		);
		migrated.close();

		expect(changedAtByEntity).toEqual({
			"task-claimed": lifecycleTimes.claimed,
			"task-progress": lifecycleTimes.inProgress,
			"task-blocked": lifecycleTimes.blocked,
			"task-completed": lifecycleTimes.completed,
			"bug-resolved": lifecycleTimes.resolved,
		});
	});
});
