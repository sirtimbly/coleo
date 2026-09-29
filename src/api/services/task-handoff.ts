import { HttpError } from "../middleware/error";
import type { Database } from "bun:sqlite";
import type { PreparedTaskRequest, PreparedTaskResponse } from "../../types/task-handoff";

interface HandoffTask {
	id: string;
	status: string;
	dependency_blocked: number;
	source_ref: string | null;
	plan_line_uid: string | null;
}

function isCompletePreparedPayload(payload: unknown, task: HandoffTask): payload is Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const value = payload as Record<string, unknown>;
	const stringArray = (entry: unknown): entry is string[] =>
		Array.isArray(entry) && entry.every((item) => typeof item === "string" && item.trim().length > 0);
	const contextReady = typeof value.context === "string"
		? value.context.trim().length > 0
		: Boolean(value.context && typeof value.context === "object" && !Array.isArray(value.context));
	const provenance = typeof value.sourceRef === "string" && value.sourceRef.trim().length > 0
		|| Boolean(task.source_ref || task.plan_line_uid);
	return provenance && stringArray(value.acceptanceCriteria) && value.acceptanceCriteria.length > 0
		&& stringArray(value.dependencies) && contextReady
		&& stringArray(value.outputs) && value.outputs.length > 0;
}

/** Persist the draft, its dependency edges, and its handoff together. */
export function createPreparedTask(db: Database, input: PreparedTaskRequest): PreparedTaskResponse {
	return db.transaction((): PreparedTaskResponse => {
		const dependencies = [...new Set(input.dependencies)];
		for (const id of dependencies) {
			if (!db.query("SELECT id FROM tasks WHERE id = ?").get(id)) {
				throw HttpError.badRequest(`Dependency task not found: ${id}`);
			}
		}
		const taskId = `task-${crypto.randomUUID()}`;
		const handoffId = `handoff-${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		const prepared = { ...input, dependencies };
		db.run(`INSERT INTO tasks (
			id, subject, description, status, priority, source_type, source_ref, context,
			prepared_by_arm_id, prepared_at, created_at, updated_at
		) VALUES (?, ?, ?, 'draft', ?, 'plan', ?, ?, ?, ?, ?, ?)`, [
			taskId, input.subject, input.description, input.priority, input.sourceRef,
			JSON.stringify(prepared), input.preparedBy, now, now, now,
		]);
		for (const id of dependencies) {
			db.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", [taskId, id]);
		}
		db.run(`INSERT INTO task_handoffs
			(id, task_id, status, prepared_by, prepared_at, queued_at, payload)
			VALUES (?, ?, 'queued', ?, ?, ?, ?)`, [handoffId, taskId, input.preparedBy, now, now, JSON.stringify(prepared)]);
		return {
			task: { id: taskId, subject: input.subject, status: "draft", priority: input.priority },
			handoff: { id: handoffId, taskId, status: "queued" },
		};
	})();
}

/** The readiness checks and both state changes must share a transaction. */
export function activateTaskHandoff(db: Database, handoffId: string): { taskId: string; activatedAt: string } {
	return db.transaction(() => {
		const handoff = db.query("SELECT task_id, payload FROM task_handoffs WHERE id = ? AND status = 'queued'")
			.get(handoffId) as { task_id: string; payload: string } | null;
		if (!handoff) throw HttpError.notFound(`Queued handoff not found: ${handoffId}`);
		const task = db.query("SELECT id, status, dependency_blocked, source_ref, plan_line_uid FROM tasks WHERE id = ?")
			.get(handoff.task_id) as HandoffTask | null;
		if (!task) throw HttpError.notFound(`Task not found: ${handoff.task_id}`);
		if (!["draft", "pending"].includes(task.status)) {
			throw new HttpError(409, "Only draft or pending tasks can be activated");
		}
		let payload: unknown;
		try { payload = JSON.parse(handoff.payload); }
		catch { throw new HttpError(409, "Prepared task payload is invalid"); }
		if (!isCompletePreparedPayload(payload, task)) {
			throw new HttpError(409, "Prepared task must include canonical plan provenance, acceptance criteria, dependencies, context, and outputs");
		}
		if (task.dependency_blocked === 1) throw new HttpError(409, "Task dependencies are not satisfied");
		// Preparation can declare dependencies that have not yet been copied into
		// the graph. Resolve exact task/plan references and fail closed on ambiguity.
		for (const reference of payload.dependencies as string[]) {
			const matches = db.query("SELECT id, status FROM tasks WHERE id = ? OR source_ref = ? OR plan_line_uid = ?")
				.all(reference, reference, reference) as Array<{ id: string; status: string }>;
			if (matches.length !== 1 || matches[0]!.status !== "completed") {
				throw new HttpError(409, `Task dependency is not satisfied: ${reference}`);
			}
		}
		const unmet = db.query(`SELECT 1 FROM task_dependencies d
			LEFT JOIN tasks dependency ON dependency.id = d.depends_on_task_id
			WHERE d.task_id = ? AND (dependency.id IS NULL OR dependency.status != 'completed') LIMIT 1`).get(task.id);
		if (unmet) throw new HttpError(409, "Task dependencies are not satisfied");
		const now = new Date().toISOString();
		db.run("UPDATE task_handoffs SET status = 'activated', activated_at = ? WHERE id = ?", [now, handoffId]);
		db.run("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'draft'", [now, task.id]);
		return { taskId: task.id, activatedAt: now };
	})();
}
