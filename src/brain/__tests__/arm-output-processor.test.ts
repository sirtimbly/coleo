import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	ArmOutputProcessor,
	type ArmOutputDecision,
} from "../arm-output-processor";

describe("ArmOutputProcessor", () => {
	const originalApiKey = process.env.OPENAI_API_KEY;
	const originalModel = process.env.OPENAI_MODEL;
	const originalBaseUrl = process.env.OPENAI_BASE_URL;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		process.env.OPENAI_MODEL = "gpt-5-mini";
		process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
	});

	afterEach(() => {
		process.env.OPENAI_API_KEY = originalApiKey;
		process.env.OPENAI_MODEL = originalModel;
		process.env.OPENAI_BASE_URL = originalBaseUrl;
		globalThis.fetch = originalFetch;
	});

	it("returns parsed LLM action response", async () => {
		process.env.OPENAI_API_KEY = "test-key";

		globalThis.fetch = (async () => {
			const payload: { choices: Array<{ message: { content: string } }> } = {
				choices: [
					{
						message: {
							content: JSON.stringify({
								action: "create_task",
								reasoning: "Assistant asked brain to create a task",
								confidence: 0.92,
								task: {
									subject: "Follow-up item",
									description: "Create a follow-up task",
									priority: "high",
								},
								armPrompt: "I created the task. Please proceed.",
							}),
						},
					},
				],
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const processor = new ArmOutputProcessor(() => {});
		const decision = await processor.processOutput(
			"arm-1",
			"arm-1",
			"Please create a follow-up task for this refactor.",
			"System prompt",
		);

		expect(decision.action).toBe("create_task");
		expect(decision.task?.subject).toBe("Follow-up item");
		expect(decision.armPrompt).toBe("I created the task. Please proceed.");
		expect(decision.confidence).toBe(0.92);
	});

	it("falls back to no_action when output is not actionable", async () => {
		delete process.env.OPENAI_API_KEY;
		const processor = new ArmOutputProcessor(() => {});
		const decision = await processor.processOutput(
			"arm-2",
			"arm-2",
			"I completed a bunch of updates and waiting.",
			"System prompt",
		);

		expect(decision.action).toBe("no_action");
		expect(decision.reasoning.length).toBeGreaterThan(0);
	});

	it("normalizes unsupported actions to no_action", async () => {
		process.env.OPENAI_API_KEY = "test-key";

		globalThis.fetch = (async () => {
			const payload: { choices: Array<{ message: { content: string } }> } = {
				choices: [
					{
						message: {
							content: JSON.stringify({
								action: "delete_everything",
								reasoning: "bad action",
								confidence: 2,
							}),
						},
					},
				],
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const processor = new ArmOutputProcessor(() => {});
		const decision: ArmOutputDecision = await processor.processOutput(
			"arm-3",
			"arm-3",
			"Whatever",
			"System prompt",
		);

		expect(decision.action).toBe("no_action");
		expect(decision.confidence).toBe(1);
	});
});
