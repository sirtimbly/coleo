import { resolveBrainModelConfigSource } from "./model-config";
import type { BrainModelConfigSource } from "./model-config";

export type ArmOutputAction =
	| "no_action"
	| "create_task"
	| "log_bug"
	| "update_task";

export interface ArmOutputDecision {
	action: ArmOutputAction;
	reasoning: string;
	confidence?: number;
	armPrompt?: string;
	task?: {
		subject?: string;
		description?: string;
		priority?: "critical" | "high" | "normal" | "low";
		domain?: string;
		classification?: string;
	};
	bug?: {
		title?: string;
		description?: string;
		priority?: "low" | "medium" | "high" | "critical";
		sourceTaskId?: string;
	};
	update?: {
		taskId?: string;
		status?:
			| "pending"
			| "claimed"
			| "in_progress"
			| "completing"
			| "completed"
			| "failed"
			| "blocked";
		subject?: string;
		description?: string;
		priority?: "critical" | "high" | "normal" | "low";
	};
}

export class ArmOutputProcessor {
	private logger: (message: string) => void;
	private modelConfigSource?: BrainModelConfigSource;

	constructor(logger: (message: string) => void, modelConfigSource?: BrainModelConfigSource) {
		this.logger = logger;
		this.modelConfigSource = modelConfigSource;
	}

	async processOutput(
		armId: string,
		armName: string,
		outputText: string,
		systemPrompt: string,
	): Promise<ArmOutputDecision> {
		const { apiKey, baseUrl, model } = await resolveBrainModelConfigSource(this.modelConfigSource);
		if (!apiKey) {
			return this.fallbackParse(outputText);
		}

		const userMessage = `Arm ID: ${armId}\nArm Name: ${armName}\n\nAssistant output:\n${outputText}`;

		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: userMessage },
					],
					max_completion_tokens: userMessage.length + 1800,
				}),
			});

			if (!response.ok) {
				const err = await response.text();
				this.logger(
					`[arm-output-processor] OpenAI API error: ${err.substring(0, 200)}`,
				);
				return this.fallbackParse(outputText);
			}

			const data = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			const content = data.choices?.[0]?.message?.content || "";
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				return this.fallbackParse(outputText);
			}

			const parsed = JSON.parse(jsonMatch[0]) as ArmOutputDecision;
			return this.normalizeDecision(parsed);
		} catch (err) {
			this.logger(`[arm-output-processor] LLM processing error: ${err}`);
			return this.fallbackParse(outputText);
		}
	}

	private normalizeDecision(input: ArmOutputDecision): ArmOutputDecision {
		const normalizedAction =
			input.action === "create_task" ||
			input.action === "log_bug" ||
			input.action === "update_task"
				? input.action
				: "no_action";

		const confidence =
			typeof input.confidence === "number" && Number.isFinite(input.confidence)
				? Math.min(Math.max(input.confidence, 0), 1)
				: undefined;

		return {
			action: normalizedAction,
			reasoning: input.reasoning || "LLM decision",
			confidence,
			armPrompt:
				typeof input.armPrompt === "string" ? input.armPrompt.trim() : undefined,
			task: input.task,
			bug: input.bug,
			update: input.update,
		};
	}

	private fallbackParse(outputText: string): ArmOutputDecision {
		const lower = outputText.toLowerCase();
		const appearsWaitingForInput =
			lower.includes("waiting for user input") ||
			lower.includes("awaiting user input") ||
			lower.includes("waiting on user input") ||
			lower.includes("need user input") ||
			lower.includes("requires user input") ||
			lower.includes("waiting for approval") ||
			lower.includes("what should i do next") ||
			lower.includes("can't proceed without");

		if (appearsWaitingForInput) {
			return {
				action: "no_action",
				reasoning: "Fallback keyword match: arm appears blocked waiting for user input",
				confidence: 0.5,
				armPrompt:
					"Do not wait for user input. If your current task is complete, call complete_task and then get_full_briefing for the next task. Otherwise continue iterating on your current task with the next concrete implementation step and report progress.",
			};
		}

		if (
			lower.includes("log a bug") ||
			lower.includes("file a bug") ||
			lower.includes("open a bug")
		) {
			return {
				action: "log_bug",
				reasoning: "Fallback keyword match: bug request",
				confidence: 0.4,
				bug: {
					title: "Bug reported by arm output",
					description: outputText.slice(0, 1200),
					priority: "medium",
				},
			};
		}

		if (
			lower.includes("create a task") ||
			lower.includes("new task") ||
			lower.includes("next task")
		) {
			return {
				action: "create_task",
				reasoning: "Fallback keyword match: task creation request",
				confidence: 0.4,
				task: {
					subject: "Follow-up task from arm output",
					description: outputText.slice(0, 1200),
					priority: "normal",
				},
			};
		}

		return {
			action: "no_action",
			reasoning: "Fallback: no clear actionable request",
			confidence: 0.3,
		};
	}
}
