import { describe, expect, it } from "bun:test";
import { evaluateEscalations } from "../bug-escalation";

describe("evaluateEscalations", () => {
	it("does not repeat a persisted level for the same task-bug pair", () => {
		const results = evaluateEscalations(
			[
				{
					taskId: "task-1",
					taskSubject: "Blocked task",
					blockedAt: new Date(),
					blockingBugs: [
						{
							id: "bug-1",
							title: "Blocking bug",
							priority: "medium",
							status: "open",
						},
					],
				},
			],
			new Map([["task-1:bug-1", 0]]),
			[
				{
					level: 0,
					name: "notice",
					minMinutesBlocked: 0,
					action: "log",
					notifyHuman: false,
				},
			],
		);

		expect(results).toEqual([]);
	});
});
