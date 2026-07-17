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
});
