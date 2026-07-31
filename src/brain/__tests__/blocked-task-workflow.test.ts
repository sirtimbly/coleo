import { describe, expect, it } from "bun:test";

import type { Arm, Task } from "../../types";
import { validateBrainInboxPayload } from "../../types/brain-inbox";
import { Brain } from "../brain";
import {
	getNextBlockedReviewAt,
	selectBlockedTasksForReview,
} from "../blocked-task-workflow";

function blockedTask(id: string, recheckAt: string, subject = id): Task {
	return {
		id,
		subject,
		description: `Review ${subject}`,
		status: "blocked",
		priority: "normal",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		blockedAt: new Date("2026-01-01T00:00:00.000Z"),
		blockedReason: "Original blocker",
		blockedCategory: "unknown",
		blockedRecheckAt: new Date(recheckAt),
	};
}

describe("blocked task workflow", () => {
	it("selects due work in review-time order without starving later tasks", () => {
		const now = new Date("2026-01-02T12:00:00.000Z");
		const tasks = [
			blockedTask("later", "2026-01-02T11:00:00.000Z"),
			blockedTask("first", "2026-01-02T09:00:00.000Z"),
			blockedTask("future", "2026-01-02T13:00:00.000Z"),
		];

		expect(selectBlockedTasksForReview(tasks, now, 10).map((task) => task.id)).toEqual([
			"first",
			"later",
		]);
	});

	it("backs off repeated reviews and checks human blockers daily", () => {
		const now = new Date("2026-01-02T12:00:00.000Z");
		expect(getNextBlockedReviewAt(0, false, now)).toBe("2026-01-02T12:15:00.000Z");
		expect(getNextBlockedReviewAt(2, false, now)).toBe("2026-01-02T16:00:00.000Z");
		expect(getNextBlockedReviewAt(20, false, now)).toBe("2026-01-03T00:00:00.000Z");
		expect(getNextBlockedReviewAt(0, true, now)).toBe("2026-01-03T12:00:00.000Z");
	});

	it("does not send planning failures to an arm for automatic review", () => {
		const task = blockedTask("planning", "2020-01-01T00:00:00.000Z");
		task.blockedCategory = "planning";

		expect(selectBlockedTasksForReview([task], new Date("2026-01-02T12:00:00.000Z"))).toEqual([]);
	});

	it("rejects malformed blocked-task review payloads", () => {
		expect(validateBrainInboxPayload("blocked_task_review", {
			taskId: "task-1",
			outcome: "maybe",
			summary: "Unsure",
		})).toContain("payload.outcome");
		expect(validateBrainInboxPayload("blocked_task_review", {
			taskId: "task-1",
			outcome: "still_blocked",
			summary: "Still waiting",
			reason: "Waiting for credentials",
			category: "invalid",
		})).toContain("payload.category");
		expect(validateBrainInboxPayload("blocked_task_review", {
			taskId: "task-1",
			outcome: "still_blocked",
			summary: "Still waiting",
			reason: "Waiting for credentials",
			needsHuman: "yes",
		})).toContain("payload.needsHuman");
		expect(validateBrainInboxPayload("blocked_task_review", {
			taskId: "task-1",
			outcome: "still_blocked",
			summary: "The plan still needs work",
			reason: "Missing architecture decision",
			category: "planning",
		})).toBeNull();
	});

	it("assigns old housekeeping reviews to idle arms through the review protocol", async () => {
		const brain = new Brain({ coleoDir: "/tmp", pollIntervalMs: 1000, verbose: false });
		const arms = new Map<string, Arm>([
			[
				"arm-1",
				{
					id: "arm-1",
					name: "Reviewer",
					agent: "opencode",
					status: "idle",
					startedAt: new Date(),
				},
			],
		]);
		(brain as any).arms = arms;

		let listOptions: Record<string, unknown> | undefined;
		(brain as any).listTasksFromApi = async (options: Record<string, unknown>) => {
			listOptions = options;
			return [blockedTask("task-old", "2020-01-01T00:00:00.000Z", "Verify and polish old work")];
		};
		(brain as any).listTaskCommentsFromApi = async () => [
			{
				content: "This may already be done.",
				authorType: "human",
				authorName: "Human",
				createdAt: new Date().toISOString(),
			},
		];
		const taskPatches: Array<Record<string, unknown>> = [];
		(brain as any).patchTaskViaApi = async (_taskId: string, patch: Record<string, unknown>) => {
			taskPatches.push(patch);
			return null;
		};
		(brain as any).patchArmViaApi = async () => null;
		const prompts: string[] = [];
		(brain as any).sendPromptToArm = async (_arm: string, prompt: string) => {
			prompts.push(prompt);
			return true;
		};
		(brain as any).logActivity = () => undefined;

		await (brain as any).reviewBlockedTasks();

		expect(listOptions).toMatchObject({ status: ["blocked"], includeHousekeeping: true });
		expect(taskPatches[0]).toMatchObject({
			status: "blocked",
			blockedReviewArmId: "arm-1",
		});
		expect(prompts[0]).toContain("Verify and polish old work");
		expect(prompts[0]).toContain("This may already be done.");
		expect(prompts[0]).toContain("review_blocked_task");
		expect(arms.get("arm-1")?.status).toBe("busy");
	});
});
