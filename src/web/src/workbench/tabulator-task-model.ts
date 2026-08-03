/**
 * Pure data adapters for the opt-in Tabulator Tasks migration spike.
 *
 * Keeping row conversion, editable-field validation, and reorder translation
 * outside the renderer makes the spike testable without loading either grid
 * runtime and preserves ResourceSheet's existing API contract.
 */

import type { Task } from "@/lib";
import type { TaskUpdate } from "./resource-updates";
import type { ResourceSheetRowMove } from "./ResourceSheet";

export const TABULATOR_TASK_STATUSES: readonly Task["status"][] = [
	"draft",
	"pending",
	"claimed",
	"in_progress",
	"completing",
	"completed",
	"blocked",
	"failed",
	"cancelled",
];

export interface TabulatorTaskRow {
	id: string;
	subject: string;
	status: Task["status"];
	priority: Task["priority"];
	phase: string;
	domain: string;
	arm: string;
	progress: number;
	source: string;
	updatedAt: string;
	bold: boolean;
	color: string;
}

export function toTabulatorTaskRows(tasks: readonly Task[]): TabulatorTaskRow[] {
	return tasks.map((task) => ({
		id: task.id,
		subject: task.subject,
		status: task.status,
		priority: task.priority,
		phase: task.phase ?? "",
		domain: task.domain ?? "",
		arm: task.assignedArmName ?? task.assignedTo ?? "",
		progress: task.progress ?? 0,
		source: task.sourceType,
		updatedAt: new Date(task.updatedAt).toLocaleString(),
		bold: task.metadata.ui?.bold ?? false,
		color: task.metadata.ui?.color ?? "slate",
	}));
}

export function createTabulatorTaskUpdate(
	field: string,
	value: unknown,
): TaskUpdate | undefined {
	if (field === "subject" && typeof value === "string") {
		const subject = value.trim();
		return subject ? { subject } : undefined;
	}

	if (
		field === "status" &&
		typeof value === "string" &&
		TABULATOR_TASK_STATUSES.includes(value as Task["status"])
	) {
		return { status: value as Task["status"] };
	}

	return undefined;
}

export function resolveTabulatorTaskMove(
	tasks: readonly Task[],
	movedTaskId: string,
	fromIndex: number,
	orderedTaskIds: readonly string[],
): ResourceSheetRowMove<Task> | undefined {
	const movedTask = tasks.find((task) => task.id === movedTaskId);
	const toIndex = orderedTaskIds.indexOf(movedTaskId);
	if (!movedTask || toIndex < 0 || fromIndex < 0 || fromIndex === toIndex) {
		return undefined;
	}

	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	return {
		row: movedTask,
		fromIndex,
		toIndex,
		previousRow: tasksById.get(orderedTaskIds[toIndex - 1] ?? ""),
		nextRow: tasksById.get(orderedTaskIds[toIndex + 1] ?? ""),
	};
}
