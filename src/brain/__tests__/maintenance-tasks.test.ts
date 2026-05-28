import { describe, expect, it } from "bun:test";
import { shouldRunMaintenanceTask } from "../maintenance-tasks";
import type { MaintenanceTaskConfig } from "../../types";

function task(
	overrides: Partial<MaintenanceTaskConfig> = {},
): MaintenanceTaskConfig {
	return {
		id: "metadata-cleanup",
		enabled: true,
		title: "Metadata cleanup",
		slices: ["discoveries", "plans"],
		priority: "normal",
		domain: "maintenance",
		classification: "maintenance",
		requireEmptyQueue: false,
		triggers: {},
		lastRunAt: null,
		lastCompletedTaskCount: null,
		lastMainCommit: null,
		...overrides,
	};
}

describe("maintenance task triggers", () => {
	it("runs when the hourly interval has never run", () => {
		const decision = shouldRunMaintenanceTask(
			task({ triggers: { everyHours: 24 } }),
			{ now: new Date("2026-05-25T12:00:00Z"), completedTaskCount: 0 },
		);

		expect(decision.shouldRun).toBe(true);
		expect(decision.reasons[0]).toContain("no previous run");
	});

	it("runs after enough completed tasks", () => {
		const decision = shouldRunMaintenanceTask(
			task({
				triggers: { everyCompletedTasks: 5 },
				lastCompletedTaskCount: 10,
			}),
			{ now: new Date("2026-05-25T12:00:00Z"), completedTaskCount: 15 },
		);

		expect(decision.shouldRun).toBe(true);
		expect(decision.reasons[0]).toContain("5 completed tasks");
	});

	it("runs when an allowed main branch commit changes", () => {
		const decision = shouldRunMaintenanceTask(
			task({
				triggers: { onMainCommit: true, branches: ["master"] },
				lastMainCommit: "old",
			}),
			{
				now: new Date("2026-05-25T12:00:00Z"),
				completedTaskCount: 0,
				currentBranch: "master",
				currentCommit: "newcommitsha",
			},
		);

		expect(decision.shouldRun).toBe(true);
		expect(decision.mainCommit).toBe("newcommitsha");
	});

	it("does not run on commit changes from non-main branches", () => {
		const decision = shouldRunMaintenanceTask(
			task({
				triggers: { onMainCommit: true, branches: ["main", "master"] },
				lastMainCommit: "old",
			}),
			{
				now: new Date("2026-05-25T12:00:00Z"),
				completedTaskCount: 0,
				currentBranch: "feature",
				currentCommit: "newcommitsha",
			},
		);

		expect(decision.shouldRun).toBe(false);
	});
});
