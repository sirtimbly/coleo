import { type Task } from "../lib/api";

export interface TaskTimelineSelection {
	current?: Task;
	upcoming?: Task;
	completed: Task[];
}

function taskTime(value: string | null | undefined): number {
	const time = value ? Date.parse(value) : Number.NaN;
	return Number.isNaN(time) ? 0 : time;
}

export function formatTimelineTime(value: string | null | undefined): string {
	if (!value) return "Not scheduled";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "Unknown time"
		: date.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
}

export function selectTaskTimeline(tasks: readonly Task[]): TaskTimelineSelection {
	const currentTasks = tasks
		.filter((task) => ["in_progress", "claimed", "completing"].includes(task.status))
		.sort(
			(left, right) =>
				taskTime(right.startedAt ?? right.claimedAt ?? right.updatedAt) -
				taskTime(left.startedAt ?? left.claimedAt ?? left.updatedAt),
		);

	const upcomingTasks = tasks
		.filter((task) => task.status === "pending" && !task.dependencyBlocked)
		.sort(
			(left, right) =>
				taskTime(left.dueDate ?? left.createdAt) -
				taskTime(right.dueDate ?? right.createdAt),
		);

	const completedTasks = tasks
		.filter((task) => task.status === "completed" && task.completedAt)
		.sort((left, right) => taskTime(right.completedAt) - taskTime(left.completedAt))
		.slice(0, 5);

	return {
		current: currentTasks[0],
		upcoming: upcomingTasks[0],
		completed: completedTasks,
	};
}
