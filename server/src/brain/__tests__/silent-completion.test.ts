import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Brain } from "../brain";
import type { Arm } from "../../types";

describe("Brain silent completion detection", () => {
	let brain: Brain;
	const arm: Arm = {
		id: "arm-1",
		name: "ArmOne",
		agent: "opencode",
		status: "busy",
		currentTask: "task-silent",
		startedAt: new Date(),
	};

	beforeEach(async () => {
		brain = new Brain({
			coleoDir: process.cwd(),
			pollIntervalMs: 1000,
			verbose: false,
		});
		await (brain as any).templates.ensureTemplatesExist();
	});

	afterEach(() => {
		brain.stop();
	});

	it("uses the newest status report from the API response", async () => {
		(brain as any).getTaskFromApi = async () => ({
			id: "task-silent",
			subject: "Silent task",
		});
		(brain as any).apiRequest = async () => ({
			reports: [
				{
					id: "latest-blocked",
					status: "blocked",
					summary: "Actually blocked now",
					issues: ["Need clarification"],
					testsStatus: "failing",
				},
				{
					id: "older-complete",
					status: "on_track",
					summary: "Everything is done",
					issues: [],
					testsStatus: "passing",
				},
			],
		});
		(brain as any).readArmLogs = async () => "completed successfully";

		const result = await (brain as any).detectSilentCompletion(arm);

		expect(result).toEqual({
			isComplete: false,
			taskId: "task-silent",
			confidence: 0.2,
			reasoning: "Recent output indicates completion.",
		});
	});

	it("auto-completes high-confidence silent completion", async () => {
		const prompts: string[] = [];
		let completed = false;

		(brain as any).getTaskFromApi = async () => ({
			id: "task-silent",
			subject: "Silent task",
		});
		(brain as any).sendPromptToArm = async (_armName: string, prompt: string) => {
			prompts.push(prompt);
			return true;
		};
		(brain as any).completeTask = async () => {
			completed = true;
		};

		await (brain as any).handleStuckArm(arm, {
			isStuck: true,
			stuckType: "silent_completion",
			reasoning: "Status is on_track and tests are passing",
			suggestedAction: "prompt_complete_task",
			confidence: 0.95,
			silentCompletion: {
				taskId: "task-silent",
				filesChanged: ["src/example.ts"],
				testsStatus: "passing",
				isReadyForCompletion: true,
			},
		});

		expect(prompts).toHaveLength(0);
		expect(completed).toBe(true);
	});
});
