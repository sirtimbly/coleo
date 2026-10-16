import { describe, expect, it } from "bun:test";

import { type Task } from "../src/lib/api";
import { selectTaskTimeline } from "../src/pages/task-timeline";

function createTask(overrides: Partial<Task>): Task {
	return {
		id: "task-0",
		subject: "Task",
		description: "",
		status: "pending",
		priority: "normal",
		sourceType: "manual",
		sourceRef: null,
		phase: null,
		domain: null,
		assignedTo: null,
		dueDate: null,
		artifacts: [],
		metadata: {},
		createdAt: "2026-01-01T09:00:00.000Z",
		updatedAt: "2026-01-01T09:00:00.000Z",
		completedAt: null,
		claimedAt: null,
		startedAt: null,
		...overrides,
	} as Task;
}

describe("task-timeline", () => {
	it("selects most recent active task for current", () => {
		const tasks = [
			createTask({
				id: "current-old",
				status: "claimed",
				claimedAt: "2026-01-01T09:00:00.000Z",
				updatedAt: "2026-01-01T09:00:00.000Z",
			}),
			createTask({
				id: "current-new",
				status: "in_progress",
				startedAt: "2026-01-01T12:00:00.000Z",
				updatedAt: "2026-01-01T12:00:00.000Z",
			}),
			createTask({
				id: "current-middle",
				status: "completing",
				startedAt: "2026-01-01T10:00:00.000Z",
				updatedAt: "2026-01-01T10:00:00.000Z",
			}),
		];

		const { current } = selectTaskTimeline(tasks);

		expect(current?.id).toBe("current-new");
	});

	it("chooses the highest-priority pending task for up next", () => {
		const tasks = [
			createTask({
				id: "upcoming-late",
				status: "pending",
				dependencyBlocked: false,
				dueDate: "2026-01-02T12:00:00.000Z",
				createdAt: "2026-01-01T07:00:00.000Z",
			}),
			createTask({
				id: "upcoming-early",
				status: "pending",
				dependencyBlocked: false,
				dueDate: "2026-01-01T12:00:00.000Z",
				createdAt: "2026-01-01T08:00:00.000Z",
			}),
			createTask({
				id: "blocked",
				status: "pending",
				dependencyBlocked: true,
				dueDate: "2026-01-01T10:00:00.000Z",
			}),
		];

		const { upcoming } = selectTaskTimeline(tasks);

		expect(upcoming?.id).toBe("upcoming-early");
	});

	it("returns the five most recent completed tasks", () => {
		const tasks = [
			createTask({
				id: "completed-1",
				status: "completed",
				completedAt: "2026-01-01T09:00:00.000Z",
			}),
			createTask({
				id: "completed-2",
				status: "completed",
				completedAt: "2026-01-01T11:00:00.000Z",
			}),
			createTask({
				id: "completed-3",
				status: "completed",
				completedAt: "2026-01-01T10:00:00.000Z",
			}),
			createTask({
				id: "completed-4",
				status: "completed",
				completedAt: "2026-01-01T12:00:00.000Z",
			}),
			createTask({
				id: "completed-5",
				status: "completed",
				completedAt: "2026-01-01T13:00:00.000Z",
			}),
			createTask({
				id: "completed-6",
				status: "completed",
				completedAt: "2026-01-01T14:00:00.000Z",
			}),
			createTask({
				id: "missing-date",
				status: "completed",
				completedAt: null,
			}),
		];

		const { completed } = selectTaskTimeline(tasks);

		expect(completed.map((task) => task.id)).toEqual([
			"completed-6",
			"completed-5",
			"completed-4",
			"completed-2",
			"completed-3",
		]);
	});
});
