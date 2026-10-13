import { Hono } from "hono";

import { initDatabase } from "../../db";
import { formatErrorResponse } from "../../api/middleware/error";
import { createWorkbenchInboxRoutes } from "../../api/routes/workbench-inbox";

import type { PagingEvidence, VerificationEvidence } from "./types";
import type { WorkbenchInboxRecord } from "../../types/adaptive-cards";

const TEST_PATHS = [
	"src/workbench/__tests__/", "src/api/__tests__/workbench-inbox-pagination.test.ts",
	"src/api/__tests__/workbench-foundation.test.ts", "src/api/__tests__/inbox-item-detail.test.ts",
	"src/api/__tests__/brain-swarm.test.ts", "src/web/__tests__/websocket-reconnect.test.ts",
	"src/web/__tests__/refresh-gate.test.ts",
	"src/scripts/__tests__/workbench-demo-report.test.ts",
	"src/api/__tests__/mail-threads.test.ts",
	"src/mail/__tests__/maildir.test.ts",
];

export function verifyWorkbenchDemo(root: string): VerificationEvidence {
	const tests = Bun.spawnSync(["bun", "test", ...TEST_PATHS], { cwd: root });
	const output = new TextDecoder().decode(tests.stdout) + new TextDecoder().decode(tests.stderr);
	if (tests.exitCode !== 0) throw new Error(`Demo verification failed:\n${output}`);
	const passed = Number(output.match(/(\d+) pass\b/)?.[1]);
	const failed = Number(output.match(/(\d+) fail\b/)?.[1]);
	const assertions = Number(output.match(/(\d+) expect\(\) calls/)?.[1]);
	if (![passed, failed, assertions].every(Number.isFinite)) throw new Error("Could not read test evidence");
	const typecheck = Bun.spawnSync(["bun", "run", "typecheck"], { cwd: root });
	if (typecheck.exitCode !== 0) {
		throw new Error(`Type checking failed:\n${new TextDecoder().decode(typecheck.stderr)}`);
	}
	const browserTypes = Bun.spawnSync(["bun", "run", "tsc", "--project", "src/scripts/workbench-demo/browser/tsconfig.json"], { cwd: root });
	if (browserTypes.exitCode !== 0) {
		throw new Error(`Report browser type checking failed:\n${new TextDecoder().decode(browserTypes.stdout)}\n` +
			new TextDecoder().decode(browserTypes.stderr));
	}
	return { passed, failed, assertions, typecheck: true };
}

/** Measures the current Hono endpoint over an isolated, migrated SQLite database. No live Coleo state is touched. */
export async function collectPagingEvidence(): Promise<PagingEvidence> {
	const db = await initDatabase(":memory:");
	const timestamp = "2026-10-01T12:00:00.000Z";
	const pageSize = 25;
	try {
		db.transaction(() => {
			for (let index = 0; index < 525; index++) {
				const id = `task-${String(index).padStart(4, "0")}`;
				db.run(`INSERT INTO tasks (id, subject, description, status, priority, source_type,
					blocked_reason, created_at, updated_at)
					VALUES (?, ?, 'Demo paging fixture', 'blocked', 'high', 'manual', 'Fixture decision', ?, ?)`,
					[id, id, timestamp, timestamp]);
			}
			for (let index = 0; index < 7; index++) {
				db.run(`INSERT INTO status_reports (id, task_id, arm_id, status, summary, created_at)
					VALUES (?, 'task-0000', 'fixture-arm', 'needs_review', 'Review fixture', ?)`,
					[`report-${index}`, timestamp]);
			}
		})();
		const app = new Hono<{ Variables: { db: typeof db } }>();
		app.use("*", async (context, next) => { context.set("db", db); await next(); });
		app.onError((error, context) => formatErrorResponse(context, error));
		app.route("/inbox", createWorkbenchInboxRoutes());
		const after: number[] = [];
		const keys: string[] = [];
		let cursor: string | undefined;
		for (let index = 0; index < 100; index++) {
			const params = new URLSearchParams({ limit: String(pageSize) });
			if (cursor) params.set("cursor", cursor);
			const response = await app.request(`/inbox?${params}`);
			if (!response.ok) throw new Error(`Paging demo failed: ${await response.text()}`);
			const page = await response.json() as { items: WorkbenchInboxRecord[]; nextCursor?: string };
			keys.push(...page.items.map((item) => item.itemKey));
			after.push(keys.length);
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		const total = (db.query("SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM status_reports) AS total")
			.get() as { total: number }).total;
		if (keys.length !== total || new Set(keys).size !== total) throw new Error("Paging fixture was not fully traversed");

		// Explicit reproduction of the pre-fix prefix-then-cursor algorithm, not a second running API version.
		const prefixLimit = Math.min(pageSize * 2, 400);
		const oldPrefix = [
			...db.query("SELECT 'task:' || id AS id, updated_at AS timestamp FROM tasks ORDER BY updated_at DESC LIMIT ?")
				.all(prefixLimit),
			...db.query("SELECT 'status:' || id AS id, created_at AS timestamp FROM status_reports ORDER BY created_at DESC LIMIT ?")
				.all(prefixLimit),
		] as Array<{ id: string; timestamp: string }>;
		const before: number[] = [];
		let boundary: { id: string; timestamp: string } | undefined;
		let found = 0;
		for (let index = 0; index < 100; index++) {
			const page = oldPrefix.filter((item) => !boundary || item.timestamp < boundary.timestamp ||
				(item.timestamp === boundary.timestamp && item.id < boundary.id))
				.sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id))
				.slice(0, pageSize);
			found += page.length;
			before.push(found);
			if (page.length < pageSize) break;
			boundary = page.at(-1);
		}
		return { fixtureTotal: total, pageSize, before, after, duplicates: keys.length - new Set(keys).size, tasks: 525, reports: 7 };
	} finally {
		db.close();
	}
}
