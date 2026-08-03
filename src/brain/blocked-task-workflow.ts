import type { Task } from "../types";

const MINUTE_MS = 60 * 1000;
const REVIEW_DELAYS_MS = [15 * MINUTE_MS, 60 * MINUTE_MS, 4 * 60 * MINUTE_MS, 12 * 60 * MINUTE_MS];
const HUMAN_REVIEW_DELAY_MS = 24 * 60 * MINUTE_MS;

export function getNextBlockedReviewAt(
	reviewCount: number,
	needsHuman: boolean,
	now = new Date(),
): string {
	const delay = needsHuman
		? HUMAN_REVIEW_DELAY_MS
		: REVIEW_DELAYS_MS[Math.min(Math.max(reviewCount, 0), REVIEW_DELAYS_MS.length - 1)]!;
	return new Date(now.getTime() + delay).toISOString();
}

function reviewTime(task: Task): number {
	const value = task.blockedRecheckAt ?? task.blockedAt ?? task.updatedAt;
	const timestamp = value.getTime();
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function selectBlockedTasksForReview(
	tasks: Task[],
	now = new Date(),
	limit = 5,
): Task[] {
	return tasks
		.filter((task) => task.status === "blocked" && reviewTime(task) <= now.getTime())
		.sort((left, right) => {
			const timeDifference = reviewTime(left) - reviewTime(right);
			if (timeDifference !== 0) return timeDifference;
			const blockedDifference = (left.blockedAt?.getTime() ?? 0) - (right.blockedAt?.getTime() ?? 0);
			if (blockedDifference !== 0) return blockedDifference;
			return left.id.localeCompare(right.id);
		})
		.slice(0, Math.max(0, limit));
}
