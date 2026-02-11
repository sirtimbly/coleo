import { describe, expect, it } from "bun:test";
import { Brain } from "../brain";
import type { Arm } from "../../types";

// Representative sample captured from /api/arms/sample-arm-events/messages on 2026-02-11.
// Includes a realistic mix of user messages, assistant tool-only messages, and assistant text messages.
const SESSION_MESSAGES_SAMPLE: unknown[] = [
	{
		info: {
			id: "msg_c4e59a1f2001BOU5WsVIbZK0o2",
			role: "user",
			time: { created: 1770841022962 },
		},
		parts: [{ type: "text", text: "System prompt payload (truncated in test)." }],
	},
	{
		info: {
			id: "msg_c4e59a202001hc45bQNKpf3At1",
			role: "assistant",
			time: { created: 1770841022978, completed: 1770841089496 },
		},
		parts: [
			{ type: "step-start" },
			{ type: "reasoning", text: "internal reasoning" },
			{ type: "tool", tool: "coleo_get_full_briefing" },
			{ type: "step-finish" },
		],
	},
	{
		info: {
			id: "msg_c4e59fe8b001ta1F8Uowh5ndy7",
			role: "user",
			time: { created: 1770841046667 },
		},
		parts: [{ type: "text", text: "Provide exactly two short plain text status lines with no tools." }],
	},
	{
		info: {
			id: "msg_c4e5aca850017fGBcstXHp0hQ5",
			role: "assistant",
			time: { created: 1770841098886, completed: 1770841104146 },
		},
		parts: [
			{ type: "step-start" },
			{
				type: "text",
				text: 'Exploring "priority escalation for files >600 lines" task\nReporting discoveries and checking blockers before implementation',
			},
			{ type: "step-finish" },
		],
	},
	{
		info: {
			id: "msg_c4e5c1b840016DkHFOjgpw0X3e",
			role: "user",
			time: { created: 1770841185156 },
		},
		parts: [{ type: "text", text: "Provide exactly two short plain text status lines with no tools." }],
	},
	{
		info: {
			id: "msg_c4e5c1b99001wBygKoJBOmFBi4",
			role: "assistant",
			time: { created: 1770841185177, completed: 1770841191872 },
		},
		parts: [
			{ type: "step-start" },
			{
				type: "text",
				text: "Claimed task phase28g-400eaf and reviewing blockers\nPlanning file grouping by size and service health checks",
			},
			{ type: "step-finish" },
		],
	},
];

describe("Brain arm output event scan", () => {
	it("formats recent assistant text messages and sends them to the arm-output LLM", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});

		const arm: Arm = {
			id: "arm-alpha",
			name: "arm-alpha",
			agent: "opencode-api",
			status: "idle",
			startedAt: new Date(),
		};

		(brain as unknown as { arms: Map<string, Arm> }).arms = new Map([
			[arm.id, arm],
		]);
		(
			brain as unknown as {
				tasks: Array<{ id: string; status: string; subject: string }>;
			}
		).tasks = [
			{ id: "task-1", status: "pending", subject: "First task" },
			{ id: "task-2", status: "in_progress", subject: "Second task" },
		];
		(brain as unknown as { state: { pendingTasks: number } }).state.pendingTasks =
			1;

		let templateArgs:
			| {
					armName: string;
					armDomain: string;
					pendingTasks: number;
					taskSnapshot: string;
			  }
			| undefined;
		(
			brain as unknown as {
				templates: {
					loadArmOutputProcessorSystemPrompt: (input: {
						armName: string;
						armDomain: string;
						pendingTasks: number;
						taskSnapshot: string;
					}) => Promise<string>;
				};
			}
		).templates = {
			loadArmOutputProcessorSystemPrompt: async (input) => {
				templateArgs = input;
				return "arm-output-system-prompt";
			},
		};

		let processCalls = 0;
		let capturedOutputText = "";
		let capturedSystemPrompt = "";
		(
			brain as unknown as {
				armOutputProcessor: {
					processOutput: (
						armId: string,
						armName: string,
						outputText: string,
						systemPrompt: string,
					) => Promise<{ action: "no_action"; reasoning: string; confidence: number }>;
				};
			}
		).armOutputProcessor = {
			processOutput: async (armId, armName, outputText, systemPrompt) => {
				processCalls += 1;
				expect(armId).toBe("arm-alpha");
				expect(armName).toBe("arm-alpha");
				capturedOutputText = outputText;
				capturedSystemPrompt = systemPrompt;
				return {
					action: "no_action",
					reasoning: "No follow-up needed",
					confidence: 0.9,
				};
			},
		};

		(
			brain as unknown as {
				apiRequest: <T>(
					path: string,
					options?: RequestInit,
					timeoutMs?: number,
				) => Promise<T>;
			}
		).apiRequest = async <T>(path: string) => {
			if (path === "/api/arms/arm-alpha/messages?limit=20") {
				return { messages: SESSION_MESSAGES_SAMPLE } as T;
			}
			throw new Error(`Unexpected apiRequest path in test: ${path}`);
		};

		await (
			brain as unknown as { processArmAssistantOutputs: () => Promise<void> }
		).processArmAssistantOutputs();

		expect(processCalls).toBe(1);
		expect(capturedSystemPrompt).toBe("arm-output-system-prompt");
		expect(templateArgs).toEqual({
			armName: "arm-alpha",
			armDomain: "general",
			pendingTasks: 1,
			taskSnapshot: "task-1 [pending] First task\ntask-2 [in_progress] Second task",
		});

		const firstIso = new Date(1770841104146).toISOString();
		const secondIso = new Date(1770841191872).toISOString();
		expect(capturedOutputText).toContain(`Assistant message 1 (${firstIso}):`);
		expect(capturedOutputText).toContain(
			'Exploring "priority escalation for files >600 lines" task',
		);
		expect(capturedOutputText).toContain(`Assistant message 2 (${secondIso}):`);
		expect(capturedOutputText).toContain(
			"Claimed task phase28g-400eaf and reviewing blockers",
		);
		expect(capturedOutputText).toContain("\n\n---\n\n");
		expect(capturedOutputText).not.toContain(
			"Provide exactly two short plain text status lines with no tools.",
		);

		// Verify dedupe behavior: same assistant messages should not be re-sent.
		await (
			brain as unknown as { processArmAssistantOutputs: () => Promise<void> }
		).processArmAssistantOutputs();
		expect(processCalls).toBe(1);
	});

	it("sends a follow-up prompt when classifier returns no_action with armPrompt", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});

		const arm: Arm = {
			id: "arm-alpha",
			name: "arm-alpha",
			agent: "opencode-api",
			status: "idle",
			startedAt: new Date(),
		};

		(brain as unknown as { arms: Map<string, Arm> }).arms = new Map([
			[arm.id, arm],
		]);
		(brain as unknown as { tasks: Array<{ id: string; status: string; subject: string }> }).tasks = [];
		(brain as unknown as { state: { pendingTasks: number } }).state.pendingTasks =
			0;

		(
			brain as unknown as {
				templates: {
					loadArmOutputProcessorSystemPrompt: () => Promise<string>;
				};
			}
		).templates = {
			loadArmOutputProcessorSystemPrompt: async () =>
				"arm-output-system-prompt",
		};

		let promptedArmName = "";
		let promptedText = "";
		(
			brain as unknown as {
				sendPromptToArm: (armName: string, message: string) => Promise<boolean>;
			}
		).sendPromptToArm = async (armName, message) => {
			promptedArmName = armName;
			promptedText = message;
			return true;
		};

		(
			brain as unknown as {
				armOutputProcessor: {
					processOutput: () => Promise<{
						action: "no_action";
						reasoning: string;
						confidence: number;
						armPrompt: string;
					}>;
				};
			}
		).armOutputProcessor = {
			processOutput: async () => ({
				action: "no_action",
				reasoning: "Arm appears to be waiting for input",
				confidence: 0.8,
				armPrompt:
					"Do not wait for user input. Complete current task or continue iterating.",
			}),
		};

		(
			brain as unknown as {
				apiRequest: <T>(path: string) => Promise<T>;
			}
		).apiRequest = async <T>(path: string) => {
			if (path === "/api/arms/arm-alpha/messages?limit=20") {
				return {
					messages: [
						{
							info: {
								id: "msg-awaiting-input-1",
								role: "assistant",
								time: { created: 1770841191872, completed: 1770841192872 },
							},
							parts: [
								{
									type: "text",
									text: "I am waiting for user input before I can continue.",
								},
							],
						},
					],
				} as T;
			}
			throw new Error(`Unexpected apiRequest path in test: ${path}`);
		};

		await (
			brain as unknown as { processArmAssistantOutputs: () => Promise<void> }
		).processArmAssistantOutputs();

		expect(promptedArmName).toBe("arm-alpha");
		expect(promptedText).toContain("Do not wait for user input");
	});

	it("does not process arm output when latest assistant message is a tool call", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});

		const arm: Arm = {
			id: "arm-alpha",
			name: "arm-alpha",
			agent: "opencode-api",
			status: "idle",
			startedAt: new Date(),
		};

		(brain as unknown as { arms: Map<string, Arm> }).arms = new Map([
			[arm.id, arm],
		]);
		(brain as unknown as { tasks: Array<{ id: string; status: string; subject: string }> }).tasks = [];
		(brain as unknown as { state: { pendingTasks: number } }).state.pendingTasks =
			0;

		let templateCalls = 0;
		(
			brain as unknown as {
				templates: {
					loadArmOutputProcessorSystemPrompt: () => Promise<string>;
				};
			}
		).templates = {
			loadArmOutputProcessorSystemPrompt: async () => {
				templateCalls += 1;
				return "arm-output-system-prompt";
			},
		};

		let processCalls = 0;
		(
			brain as unknown as {
				armOutputProcessor: {
					processOutput: () => Promise<{
						action: "no_action";
						reasoning: string;
						confidence: number;
					}>;
				};
			}
		).armOutputProcessor = {
			processOutput: async () => {
				processCalls += 1;
				return {
					action: "no_action",
					reasoning: "No follow-up needed",
					confidence: 0.9,
				};
			},
		};

		(
			brain as unknown as {
				apiRequest: <T>(path: string) => Promise<T>;
			}
		).apiRequest = async <T>(path: string) => {
			if (path === "/api/arms/arm-alpha/messages?limit=20") {
				return {
					messages: [
						{
							info: {
								id: "msg-assistant-text-old",
								role: "assistant",
								time: { created: 1770841098886, completed: 1770841104146 },
							},
							parts: [{ type: "text", text: "Older assistant text message" }],
						},
						{
							info: {
								id: "msg-assistant-tool-latest",
								role: "assistant",
								time: { created: 1770841198886, completed: 1770841200146 },
							},
							parts: [
								{ type: "step-start" },
								{ type: "tool", tool: "coleo_get_full_briefing" },
								{ type: "step-finish" },
							],
						},
					],
				} as T;
			}
			throw new Error(`Unexpected apiRequest path in test: ${path}`);
		};

		await (
			brain as unknown as { processArmAssistantOutputs: () => Promise<void> }
		).processArmAssistantOutputs();

		expect(templateCalls).toBe(0);
		expect(processCalls).toBe(0);
	});
});
