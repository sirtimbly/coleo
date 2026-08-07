/**
 * Read-only Arm run projection.
 *
 * Runs are created implicitly by database triggers when an Arm claims a task or
 * bug. This route exposes attempts without adding an explicit "start run"
 * command that does not exist in Coleo's current operating model.
 */

import { Hono } from "hono";

import { HttpError } from "../middleware";

import type { Database } from "bun:sqlite";

interface RunsContext {
	Variables: {
		db: Database;
	};
}

interface RunRow {
	id: string;
	armId: string;
	armName: string | null;
	workKind: "task" | "bug";
	workId: string;
	workTitle: string | null;
	status: "claimed" | "running" | "blocked" | "completed" | "failed" | "cancelled";
	startedAt: string;
	endedAt: string | null;
	metadata: string;
}

function mapRun(row: RunRow) {
	let metadata: Record<string, unknown> = {};
	try {
		metadata = JSON.parse(row.metadata) as Record<string, unknown>;
	} catch {
		// A malformed historical metadata field should not hide the run.
	}
	return {
		...row,
		armName: row.armName ?? row.armId,
		workTitle: row.workTitle ?? row.workId,
		endedAt: row.endedAt ?? undefined,
		metadata,
	};
}

const SELECT_RUNS = `
	SELECT
	  r.id,
	  r.arm_id AS armId,
	  a.name AS armName,
	  r.work_kind AS workKind,
	  r.work_id AS workId,
	  CASE r.work_kind
	    WHEN 'task' THEN (SELECT subject FROM tasks WHERE id = r.work_id)
	    WHEN 'bug' THEN (SELECT title FROM bugs WHERE id = r.work_id)
	  END AS workTitle,
	  r.status,
	  r.started_at AS startedAt,
	  r.ended_at AS endedAt,
	  r.metadata
	FROM arm_runs r
	LEFT JOIN arms a ON a.id = r.arm_id
`;

export function createRunsRoutes() {
	const app = new Hono<RunsContext>();

	app.get("/", (c) => {
		const db = c.get("db");
		const status = c.req.query("status");
		const armId = c.req.query("armId");
		const active = c.req.query("active");
		const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
		const where: string[] = [];
		const params: Array<string | number> = [];
		if (status) {
			where.push("r.status = ?");
			params.push(status);
		}
		if (armId) {
			where.push("r.arm_id = ?");
			params.push(armId);
		}
		if (active === "true") where.push("r.ended_at IS NULL");
		const rows = db.query(
			`${SELECT_RUNS}
			 ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY r.started_at DESC
			 LIMIT ?`,
		).all(...params, limit) as RunRow[];
		return c.json({ runs: rows.map(mapRun) });
	});

	app.get("/:id", (c) => {
		const row = c.get("db").query(
			`${SELECT_RUNS} WHERE r.id = ?`,
		).get(c.req.param("id")) as RunRow | null;
		if (!row) throw HttpError.notFound(`Run not found: ${c.req.param("id")}`);
		return c.json({ run: mapRun(row) });
	});

	return app;
}
