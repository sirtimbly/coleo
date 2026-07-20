import { resolveBrainModelConfigSource } from "./model-config";
import type { BrainModelConfigSource } from "./model-config";

interface ProcessedIntent {
	type:
		| "new_task"
		| "doc_update"
		| "bug_report"
		| "approval_response"
		| "query"
		| "prompt_arm"
		| "arm_instruction"
		| "escalate";
	subject?: string;
	body?: string;
	title?: string;
	description?: string;
	targetDoc?: string;
	originalId?: string;
	approved?: boolean;
	comment?: string;
	query?: string;
	armName?: string;
	instruction?: string;
	priority?: "critical" | "high" | "normal" | "low";
	domain?: string;
	reasoning?: string;
}

export class MailProcessor {
	private logger: (message: string) => void;
	private systemPrompt: string;
	private modelConfigSource?: BrainModelConfigSource;

	constructor(
		logger: (message: string) => void,
		systemPrompt: string,
		modelConfigSource?: BrainModelConfigSource,
	) {
		this.logger = logger;
		this.systemPrompt = systemPrompt;
		this.modelConfigSource = modelConfigSource;
	}

	async processMessage(
		subject: string,
		body: string,
		systemPrompt: string,
	): Promise<ProcessedIntent> {
		const { apiKey, baseUrl, model } = await resolveBrainModelConfigSource(this.modelConfigSource);
		if (!apiKey) {
			return this.fallbackParse(subject, body);
		}

		const userMessage = `Subject: ${subject}

Body:
${body}`;

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
					// temperature: 0.3,
					max_completion_tokens: 2500 + userMessage.length,
				}),
			});

			if (!response.ok) {
				const err = await response.text();
				this.logger(
					`[mail-processor] OpenAI API error: ${err.substring(0, 200)}`,
				);
				return this.fallbackParse(subject, body);
			}

			const data = (await response.json()) as {
				choices: Array<{ message: { content: string } }>;
			};
			// this.logger(
			// 	`[mail-processor] debug raw LLM response: ${JSON.stringify(data)}`,
			// );
			const content = data.choices[0]?.message?.content || "";

			// Parse JSON from response
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const result = JSON.parse(jsonMatch[0]) as ProcessedIntent;
				result.reasoning = result.reasoning || "LLM parsed intent";
				this.logger(
					`[mail-processor] LLM intent: ${result.type} - ${result.reasoning}`,
				);
				return result;
			}

			return this.fallbackParse(subject, body);
		} catch (err) {
			this.logger(`[mail-processor] LLM processing error: ${err}`);
			return this.fallbackParse(subject, body);
		}
	}

	private fallbackParse(subject: string, body: string): ProcessedIntent {
		const lowerSubject = subject.toLowerCase();
		const lowerBody = body.toLowerCase();

		if (lowerSubject.includes("re:") && lowerSubject.includes("approval")) {
			const approved =
				lowerBody.includes("approve") ||
				lowerBody.includes("yes") ||
				lowerBody.includes("ok");
			const ids = [...subject.matchAll(/\[([^\]]+)\]/g)];
			const originalIdMatch = ids.at(-1);
			return {
				type: "approval_response",
				originalId: originalIdMatch?.[1] || "",
				approved,
				comment: body,
				reasoning: "Fallback: detected approval response",
			};
		}

		const docPatterns = [
			/update (?:the )?docs?/i,
			/update (?:the )?requirements/i,
			/update (?:the )?plans?/i,
		];
		for (const pattern of docPatterns) {
			if (pattern.test(subject) || pattern.test(body)) {
				const docMatch = body.match(/docs\/([^\s\n]+)/i);
				return {
					type: "doc_update",
					subject: subject
						.replace(/^(update|revise|change|clarify)\s*(?:the\s*)?/i, "")
						.trim(),
					body,
					targetDoc: docMatch?.[1],
					reasoning: "Fallback: detected doc update request",
				};
			}
		}

		if (
			lowerSubject.includes("status") ||
			lowerBody.includes("what's happening")
		) {
			return {
				type: "query",
				query: "status",
				reasoning: "Fallback: detected status query",
			};
		}

		return {
			type: "new_task",
			subject: subject.replace(/^(new task:|task:)\s*/i, "").trim() || subject,
			body,
			priority: "normal",
			reasoning: "Fallback: treated as new task",
		};
	}
}
