/**
 * Escalation tracking routes
 *
 * Persists task-bug escalation state so actions are not repeated each poll.
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";

interface EscalationContext {
	Variables: {
		db: Database;
	};
}

export interface EscalationTracking {
	id: number;
	taskId: string;
	bugId: string;
	escalationLevel: number;
	lastEscalatedAt: string | null;
	notifiedHuman: boolean;
	autoAssignedBug: boolean;
	createdAt: string;
	updatedAt: string;
}

interface EscalationRow {
	id: number;
	task_id: string;
	bug_id: string;
	escalation_level: number;
	last_escalated_at: string | null;
	notified_human: number;
	auto_assigned_bug: number;
	created_at: string;
	updated_at: string;
}

function parseEscalationRow(row: EscalationRow): EscalationTracking {
	return {
		id: row.id,
		taskId: row.task_id,
		bugId: row.bug_id,
		escalationLevel: row.escalation_level,
		lastEscalatedAt: row.last_escalated_at,
		notifiedHuman: row.notified_human === 1,
		autoAssignedBug: row.auto_assigned_bug === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const SELECT_ESCALATION = `
	SELECT id, task_id, bug_id, escalation_level, last_escalated_at,
	       notified_human, auto_assigned_bug, created_at, updated_at
	FROM escalation_tracking
`;

export function createEscalationRoutes() {
	const app = new Hono<EscalationContext>();

	app.get("/", (c) => {
		const db = c.get("db");
		const taskId = c.req.query("taskId");
		const bugId = c.req.query("bugId");
		const minLevel = c.req.query("minLevel");
		const conditions: string[] = [];
		const params: Array<string | number> = [];

		if (taskId) {
			conditions.push("task_id = ?");
			params.push(taskId);
		}
		if (bugId) {
			conditions.push("bug_id = ?");
			params.push(bugId);
		}
		if (minLevel !== undefined) {
			const parsedLevel = Number.parseInt(minLevel, 10);
			if (!Number.isInteger(parsedLevel) || parsedLevel < 0) {
				throw new HttpError(400, "minLevel must be a non-negative integer");
			}
			conditions.push("escalation_level >= ?");
			params.push(parsedLevel);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = db
			.query(`${SELECT_ESCALATION} ${where} ORDER BY escalation_level DESC, updated_at DESC`)
			.all(...params) as EscalationRow[];

		return c.json({ escalations: rows.map(parseEscalationRow) });
	});

	app.get("/:taskId/:bugId", (c) => {
		const db = c.get("db");
		const taskId = c.req.param("taskId");
		const bugId = c.req.param("bugId");
		const row = db
			.query(`${SELECT_ESCALATION} WHERE task_id = ? AND bug_id = ?`)
			.get(taskId, bugId) as EscalationRow | null;

		if (!row) {
			throw new HttpError(404, "Escalation not found");
		}

		return c.json({ escalation: parseEscalationRow(row) });
	});

	app.post("/", async (c) => {
		const db = c.get("db");
		const body = (await c.req.json()) as {
			taskId?: string;
			bugId?: string;
			escalationLevel?: number;
			notifiedHuman?: boolean;
			autoAssignedBug?: boolean;
		};

		if (!body.taskId || !body.bugId) {
			throw new HttpError(400, "taskId and bugId are required");
		}
		if (
			!Number.isInteger(body.escalationLevel) ||
			(body.escalationLevel ?? -1) < 0
		) {
			throw new HttpError(400, "escalationLevel must be a non-negative integer");
		}

		const now = new Date().toISOString();
		const existing = db
			.query(
				"SELECT id FROM escalation_tracking WHERE task_id = ? AND bug_id = ?",
			)
			.get(body.taskId, body.bugId) as { id: number } | null;

		if (existing) {
			db.run(
				`UPDATE escalation_tracking SET
					escalation_level = ?, last_escalated_at = ?,
					notified_human = COALESCE(?, notified_human),
					auto_assigned_bug = COALESCE(?, auto_assigned_bug), updated_at = ?
				WHERE id = ?`,
				[
					body.escalationLevel!,
					now,
					body.notifiedHuman === undefined ? null : body.notifiedHuman ? 1 : 0,
					body.autoAssignedBug === undefined
						? null
						: body.autoAssignedBug
							? 1
							: 0,
					now,
					existing.id,
				],
			);
		} else {
			db.run(
				`INSERT INTO escalation_tracking (
					task_id, bug_id, escalation_level, last_escalated_at,
					notified_human, auto_assigned_bug, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					body.taskId,
					body.bugId,
					body.escalationLevel!,
					now,
					body.notifiedHuman ? 1 : 0,
					body.autoAssignedBug ? 1 : 0,
					now,
					now,
				],
			);
		}

		const row = db
			.query(`${SELECT_ESCALATION} WHERE task_id = ? AND bug_id = ?`)
			.get(body.taskId, body.bugId) as EscalationRow;

		return c.json({ escalation: parseEscalationRow(row) });
	});

	app.delete("/:taskId/:bugId", (c) => {
		const db = c.get("db");
		const result = db.run(
			"DELETE FROM escalation_tracking WHERE task_id = ? AND bug_id = ?",
			[c.req.param("taskId"), c.req.param("bugId")],
		);

		if (result.changes === 0) {
			throw new HttpError(404, "Escalation not found");
		}

		return c.json({ success: true });
	});

	return app;
}
