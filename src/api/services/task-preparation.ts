/**
 * Task Preparation Agent service.
 *
 * Turns a task and its discussion history into a detailed, actionable task
 * definition that can be reviewed and then created or applied.
 */
import type { Database } from "bun:sqlite";
import { loadConfig } from "../../config";
import { resolveBrainModelConfig } from "../../brain/model-config";
import { getTaskComments } from "../../db/state";
import type { TaskComment } from "../../types";

export type TaskPriority = "critical" | "high" | "normal" | "low";

export interface PreparableTask {
	id: string;
	subject: string;
	description: string;
	priority: TaskPriority;
	classification?: string | null;
	phase?: string | null;
	sourceRef?: string | null;
}

export interface PreparedTaskDefinition {
	subject: string;
	description: string;
	context: string;
	requirements: string[];
	acceptanceCriteria: string[];
	priority: TaskPriority;
	classification: string;
	phase: string;
	estimatedEffort: string;
	sourceRef?: string;
}

interface PrepareTaskOptions {
	/** Custom guidance from the user (e.g. focus areas). */
	guidance?: string;
	/** Inject a custom fetch implementation for testing. */
	fetchFn?: typeof fetch;
}

interface LlmChoice {
	finish_reason?: string | null;
	message?: { content?: string | null };
}

interface LlmResponse {
	choices?: LlmChoice[];
}

const PRIORITY_VALUES: TaskPriority[] = ["critical", "high", "normal", "low"];

function isValidPriority(value: unknown): value is TaskPriority {
	return typeof value === "string" && PRIORITY_VALUES.includes(value as TaskPriority);
}

function formatCommentsForPrompt(comments: TaskComment[]): string {
	const parts: string[] = [];
	for (const comment of comments) {
		const author = comment.authorName || comment.authorId;
		const when = new Date(comment.createdAt).toISOString();
		parts.push(`[${comment.authorType}] ${author} at ${when}:\n${comment.content}`);
	}
	return parts.join("\n\n---\n\n");
}

function stripMarkdownFence(value: string): string {
	return value
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
}

function parsePreparedDefinition(raw: string, task: PreparableTask): PreparedTaskDefinition {
	const cleaned = stripMarkdownFence(raw);
	let parsed: Record<string, unknown> = {};

	try {
		parsed = JSON.parse(cleaned) as Record<string, unknown>;
	} catch {
		// Treat the entire output as the description if it is not valid JSON.
		return fallbackFromTask(task, cleaned);
	}

	const asStringArray = (value: unknown): string[] => {
		if (!Array.isArray(value)) return [];
		return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	};

	const asString = (value: unknown, fallback: string): string => {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
		return fallback;
	};

	return {
		subject: asString(parsed.subject, task.subject),
		description: asString(parsed.description, task.description),
		context: asString(parsed.context, ""),
		requirements: asStringArray(parsed.requirements),
		acceptanceCriteria: asStringArray(parsed.acceptanceCriteria),
		priority: isValidPriority(parsed.priority) ? parsed.priority : task.priority || "normal",
		classification: asString(parsed.classification, task.classification || ""),
		phase: asString(parsed.phase, task.phase || ""),
		estimatedEffort: asString(parsed.estimatedEffort, ""),
		sourceRef: asString(parsed.sourceRef || task.sourceRef, ""),
	};
}

function fallbackFromTask(task: PreparableTask, extraDescription?: string): PreparedTaskDefinition {
	const parts: string[] = [];
	if (task.description.trim()) parts.push(task.description.trim());
	if (extraDescription) parts.push(extraDescription);

	return {
		subject: task.subject,
		description: parts.join("\n\n"),
		context: "",
		requirements: [],
		acceptanceCriteria: [],
		priority: task.priority || "normal",
		classification: task.classification || "",
		phase: task.phase || "",
		estimatedEffort: "",
		sourceRef: task.sourceRef || "",
	};
}

export function buildPreparationPrompt(
	task: PreparableTask,
	comments: TaskComment[],
	guidance?: string,
): string {
	const discussionText = comments.length > 0
		? formatCommentsForPrompt(comments)
		: "No discussion messages yet.";

	return `You are a task-preparation agent. Turn the following task and its discussion into a detailed, actionable task definition that another arm can execute.

Current task subject: ${task.subject}
Current task description: ${task.description}
Current priority: ${task.priority || "normal"}
Current phase: ${task.phase || "none"}
Current classification: ${task.classification || "none"}
${guidance ? `\nAdditional guidance from the user: ${guidance}\n` : ""}
Discussion history:
${"=".repeat(40)}
${discussionText}
${"=".repeat(40)}

Return ONLY a JSON object (no markdown fences, no commentary) with these exact keys:
- subject: a concise, imperative task title
- description: a detailed explanation of what needs to be done, including background and motivation
- context: relevant implementation context, constraints, and helpful pointers
- requirements: an array of concrete, verifiable requirements
- acceptanceCriteria: an array of specific conditions that define "done"
- priority: one of "critical", "high", "normal", or "low"
- classification: the task classification such as "architect", "development", "qa", or "documentation"
- phase: the project phase this belongs to, if known
- estimatedEffort: a rough estimate such as "2-3 hours" or "1 day"
- sourceRef: optional reference such as a plan line UID or issue number

Be specific. Use the discussion to fill in details, split vague goals into concrete requirements, and surface unresolved questions as acceptance criteria where appropriate.`;
}

export async function prepareTaskFromDiscussion(
	db: Database,
	task: PreparableTask,
	options: PrepareTaskOptions = {},
): Promise<PreparedTaskDefinition> {
	const comments = getTaskComments(db, task.id, { limit: 200 });
	const config = resolveBrainModelConfig((await loadConfig()).brain);
	const apiKey = config.apiKey.trim();

	if (!apiKey) {
		return fallbackFromTask(task);
	}

	const fetchFn = options.fetchFn || fetch;
	const baseUrl = config.baseUrl.replace(/\/$/, "");
	const prompt = buildPreparationPrompt(task, comments, options.guidance);
	const completionTokenBudget = Math.min(
		32_000,
		Math.max(4_000, Math.ceil(prompt.length / 3) + 2_000),
	);

	const response = await fetchFn(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: config.model,
			messages: [
				{
					role: "system",
					content: "You prepare software-engineering tasks from discussions. Output valid JSON only.",
				},
				{ role: "user", content: prompt },
			],
			max_completion_tokens: completionTokenBudget,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Task preparation agent returned ${response.status}: ${text.slice(0, 200)}`);
	}

	const body = (await response.json()) as LlmResponse;
	const rawContent = body.choices?.[0]?.message?.content || "";

	if (!rawContent) {
		const finishReason = body.choices?.[0]?.finish_reason;
		throw new Error(
			finishReason
				? `Task preparation agent returned no text (finish reason: ${finishReason})`
				: "Task preparation agent returned no text",
		);
	}

	return parsePreparedDefinition(rawContent, task);
}
