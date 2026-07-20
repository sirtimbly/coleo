import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { parsePlanFile, tasksToDatabaseFormat } from "./plan-parser";
import { generateInitialKeys } from "../lib/fractional-indexing";
import {
	CANONICAL_PLAN_PATH,
	formatPlanWithConfiguredModel,
	type PlanFormatter,
} from "../project-setup/service";
import type { WorkspaceAccess } from "../workspace";

export interface RegenerateTasksResult {
	deletedCount: number;
	createdCount: number;
	preservedCompletedCount: number;
	mode: "ai" | "structured";
}

export async function regenerateTasksFromPlan(options: {
	db: Database;
	workspace: WorkspaceAccess;
	explanation: string;
	formatter?: PlanFormatter;
}): Promise<RegenerateTasksResult> {
	const explanation = options.explanation.trim();
	if (!explanation) throw new Error("Explain why the task list needs to be regenerated");

	const existingPlan = await options.workspace.readText(CANONICAL_PLAN_PATH);
	if (!existingPlan?.content.trim()) {
		throw new Error("Create and save .project/plan.md before regenerating tasks");
	}

	const formatter = options.formatter || formatPlanWithConfiguredModel;
	const assertNoActiveTaskArms = () => {
		const activeArmCount = (options.db
			.query(`SELECT COUNT(*) AS count
				FROM arms
				WHERE status IN ('busy', 'running')
					AND current_task_id IN (SELECT id FROM tasks WHERE status != 'completed')`)
			.get() as { count: number } | null)?.count ?? 0;
		const activeStateCount = (options.db
			.query(`SELECT COUNT(*) AS count
				FROM arm_state_machine
				WHERE state NOT IN ('idle', 'stopped', 'error')
					AND current_task_id IN (SELECT id FROM tasks WHERE status != 'completed')`)
			.get() as { count: number } | null)?.count ?? 0;
		if (activeArmCount > 0 || activeStateCount > 0) {
			throw new Error("Stop all arms working on active tasks before regenerating the task queue");
		}
	};
	assertNoActiveTaskArms();

	const formatted = await formatter(existingPlan.content, CANONICAL_PLAN_PATH, explanation);
	const canonicalPlan = await options.workspace.writeText(CANONICAL_PLAN_PATH, formatted.content, {
		expectedHash: existingPlan.contentHash,
	});
	const parsed = await parsePlanFile(CANONICAL_PLAN_PATH, options.workspace);
	if (parsed.errors.length > 0 || parsed.tasks.length === 0) {
		await options.workspace.writeText(CANONICAL_PLAN_PATH, existingPlan.content, {
			expectedHash: canonicalPlan.contentHash,
		});
		throw new Error(parsed.errors[0] || "The regenerated plan did not contain any tasks");
	}

	const completedTasks = options.db
		.query("SELECT id, subject, plan_line_uid FROM tasks WHERE status = 'completed'")
		.all() as Array<{ id: string; subject: string; plan_line_uid: string | null }>;
	const normalizeSubject = (subject: string) => subject.trim().replace(/\s+/g, " ").toLowerCase();
	const usedSubjectsById = new Map(
		completedTasks.map((task) => [task.id, normalizeSubject(task.subject)]),
	);
	const completedSubjects = new Set(completedTasks.map((task) => normalizeSubject(task.subject)));
	const completedPlanLineUids = new Set(
		completedTasks.flatMap((task) => task.plan_line_uid ? [task.plan_line_uid] : []),
	);
	const tasks = tasksToDatabaseFormat(parsed.tasks).flatMap((task) => {
		const normalizedSubject = normalizeSubject(task.subject);
		if (
			completedSubjects.has(normalizedSubject)
			|| (task.plan_line_uid && completedPlanLineUids.has(task.plan_line_uid))
		) return [];

		let id = task.id;
		if (usedSubjectsById.has(id)) {
			const suffix = createHash("sha256")
				.update(`${task.phase}\0${task.subject}\0${task.description}`)
				.digest("hex")
				.slice(0, 8);
			id = `${task.id}-${suffix}`;
			let duplicate = 2;
			while (usedSubjectsById.has(id)) {
				if (usedSubjectsById.get(id) === normalizedSubject) return [];
				id = `${task.id}-${suffix}-${duplicate}`;
				duplicate += 1;
			}
		}

		usedSubjectsById.set(id, normalizedSubject);
		return [{ ...task, id }];
	});
	const orderKeys = generateInitialKeys(tasks.length);
	const now = new Date().toISOString();
	let deletedCount = 0;
	let createdCount = 0;

	try {
		options.db.transaction(() => {
			assertNoActiveTaskArms();
			const resetTaskReferences = (table: string) => {
				try {
					options.db.run(
						`UPDATE ${table}
						 SET current_task_id = NULL, current_task_subject = NULL
						 WHERE current_task_id IN (SELECT id FROM tasks WHERE status != 'completed')`,
					);
				} catch {
					// Older/minimal schemas may not have runtime task references.
				}
			};
			resetTaskReferences("arms");
			resetTaskReferences("arm_state_machine");

			deletedCount = options.db.run("DELETE FROM tasks WHERE status != 'completed'").changes;
			for (const [index, task] of tasks.entries()) {
				const metadata = task.metadata ? JSON.parse(task.metadata) as Record<string, unknown> : {};
				const result = options.db.run(
					`INSERT INTO tasks (
						id, subject, description, status, priority, source_type, source_ref,
						phase, plan_line_uid, tags, metadata, sort_order, order_key,
						created_at, updated_at, completed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						task.id,
						task.subject,
						task.description,
						task.status,
						task.priority,
						task.source_type,
						task.source_ref,
						task.phase,
						task.plan_line_uid || null,
						task.tags,
						JSON.stringify({
							...metadata,
							regeneratedAt: now,
							regenerationExplanation: explanation,
						}),
						index,
						orderKeys[index]!,
						now,
						now,
						task.status === "completed" ? now : null,
					],
				);
				createdCount += result.changes;
			}
		}).immediate();
	} catch (error) {
		await options.workspace.writeText(CANONICAL_PLAN_PATH, existingPlan.content, {
			expectedHash: canonicalPlan.contentHash,
		});
		throw error;
	}

	const preservedCompletedCount = (options.db
		.query("SELECT COUNT(*) AS count FROM tasks WHERE status = 'completed'")
		.get() as { count: number } | null)?.count ?? 0;

	return {
		deletedCount,
		createdCount,
		preservedCompletedCount,
		mode: formatted.mode,
	};
}
