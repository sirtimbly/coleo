/**
 * Discovery Summarizer
 *
 * Uses an LLM to intelligently summarize and filter discoveries based on task context.
 * Takes all discoveries (global and task-specific) and produces a focused summary
 * that's relevant to the arm's current task.
 */

import type { Discovery, Task } from "../types";
import { resolveBrainModelConfig } from "./model-config";
import type { BrainModelConfig } from "./model-config";

export interface DiscoverySummary {
	/** Summarized insights relevant to the task */
	relevantInsights: string;
	/** Key blockers or issues the arm should be aware of */
	blockers: string[];
	/** Suggested approaches based on prior exploration */
	suggestedApproaches: string[];
	/** Files that were identified as relevant during exploration */
	relevantFiles: string[];
	/** Whether there are critical issues requiring immediate attention */
	hasCriticalIssues: boolean;
	/** Raw reasoning from the LLM (for debugging) */
	reasoning?: string;
}

export interface SummarizeDiscoveriesOptions {
	task: Task;
	globalDiscoveries: Discovery[];
	taskDiscoveries: Discovery[];
	maxTokens?: number;
}

/**
 * LLM-based Discovery Summarizer
 * Analyzes all discoveries and produces a task-relevant summary
 */
export class DiscoverySummarizer {
	private apiKey: string;
	private model: string;
	private baseUrl: string;
	private logger: (message: string) => void;

	constructor(logger?: (message: string) => void, modelConfig?: BrainModelConfig) {
		this.logger = logger || (() => {});
		const config = modelConfig || resolveBrainModelConfig();
		this.apiKey = config.apiKey;
		this.model = config.model;
		this.baseUrl = config.baseUrl;
	}

	/**
	 * Summarize discoveries for a specific task context
	 */
	async summarize(
		options: SummarizeDiscoveriesOptions,
	): Promise<DiscoverySummary> {
		const { task, globalDiscoveries, taskDiscoveries } = options;

		// If no discoveries, return empty summary
		if (globalDiscoveries.length === 0 && taskDiscoveries.length === 0) {
			return this.emptyResult();
		}

		// If no API key, use fallback summarization
		if (!this.apiKey) {
			this.logger("[discovery-summarizer] No API key, using fallback");
			return this.fallbackSummarize(options);
		}

		const systemPrompt = this.buildSystemPrompt();
		const userMessage = this.buildUserMessage(options);

		try {
			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: userMessage },
					],
					// temperature: 0.2,
					max_completion_tokens:
						userMessage.length + (options.maxTokens || 3000),
				}),
			});

			if (!response.ok) {
				const err = await response.text();
				this.logger(
					`[discovery-summarizer] API error: ${err.substring(0, 200)}`,
				);
				return this.fallbackSummarize(options);
			}

			const data = (await response.json()) as {
				choices: Array<{ message: { content: string } }>;
			};
			const content = data.choices[0]?.message?.content || "";

			// Parse JSON from response
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				try {
					const result = JSON.parse(jsonMatch[0]) as DiscoverySummary;
					this.logger(`[discovery-summarizer] LLM summary generated`);
					return this.normalizeResult(result);
				} catch (parseErr) {
					this.logger(`[discovery-summarizer] JSON parse error: ${parseErr}`);
					return this.fallbackSummarize(options);
				}
			}

			return this.fallbackSummarize(options);
		} catch (err) {
			this.logger(`[discovery-summarizer] LLM error: ${err}`);
			return this.fallbackSummarize(options);
		}
	}

	private buildSystemPrompt(): string {
		return `You are the Coleo Brain's discovery analyzer. Your job is to summarize discoveries from multiple AI agents (arms) to help the current arm understand context before starting work.

## Discovery Types
- **exploration phase**: Insights gathered before making changes (missing context, blockers, related code, suggested approaches)
- **implementation phase**: Issues found while making changes
- **verification phase**: Problems found during testing/review

## Discovery Kinds
- missing_context: Information needed but not found
- ambiguous_requirement: Unclear requirements needing clarification
- potential_blocker: Issues that could block progress
- related_code: Relevant code locations found during exploration
- suggested_approach: Recommended implementation strategies
- bug: Bugs found in existing code
- pattern: Code patterns observed
- tech_debt: Technical debt identified
- optimization: Performance improvement opportunities
- question: Open questions needing answers

## Your Task
Analyze all discoveries and produce a focused summary that helps the arm:
1. Understand what other arms learned during exploration
2. Know about critical blockers or issues upfront
3. See suggested approaches that worked or were proposed
4. Identify relevant files to look at

## Response Format (JSON only, no markdown):
{
  "relevantInsights": "A concise paragraph summarizing the most relevant discoveries for this specific task. Focus on what will help the arm succeed.",
  "blockers": ["List of critical blockers or issues that could prevent progress"],
  "suggestedApproaches": ["Approaches suggested by other arms that seem viable"],
  "relevantFiles": ["file/paths/mentioned/in/discoveries.ts"],
  "hasCriticalIssues": false,
  "reasoning": "Brief explanation of how you prioritized the discoveries"
}

Be concise but informative. Prioritize exploration-phase discoveries as they contain pre-work insights.`;
	}

	private buildUserMessage(options: SummarizeDiscoveriesOptions): string {
		const { task, globalDiscoveries, taskDiscoveries } = options;

		const formatDiscovery = (d: Discovery, index: number): string => {
			const phase = d.phase || "implementation";
			const severity = d.severity || "info";
			const file = d.file ? ` (${d.file}${d.line ? `:${d.line}` : ""})` : "";
			return `${index + 1}. [${phase.toUpperCase()}] [${severity.toUpperCase()}] ${d.kind}: ${d.title}${file}
   ${d.details}`;
		};

		let message = `## Current Task
Subject: ${task.subject}
Description: ${task.description}
Domain: ${task.domain || "general"}
Priority: ${task.priority}

`;

		if (taskDiscoveries.length > 0) {
			message += `## Task-Specific Discoveries (from arms that worked on this task)
${taskDiscoveries.map(formatDiscovery).join("\n\n")}

`;
		}

		if (globalDiscoveries.length > 0) {
			message += `## Global Discoveries (from all recent work)
${globalDiscoveries.map(formatDiscovery).join("\n\n")}

`;
		}

		message += `Summarize these discoveries for the arm about to work on "${task.subject}". Focus on what's most relevant to their success.`;

		return message;
	}

	/**
	 * Fallback summarization when LLM is not available
	 */
	private fallbackSummarize(
		options: SummarizeDiscoveriesOptions,
	): DiscoverySummary {
		const { task, globalDiscoveries, taskDiscoveries } = options;
		const allDiscoveries = [...taskDiscoveries, ...globalDiscoveries];

		// Extract exploration discoveries
		const explorationDiscoveries = allDiscoveries.filter(
			(d) => d.phase === "exploration",
		);

		// Extract blockers
		const blockers = allDiscoveries
			.filter((d) => d.kind === "potential_blocker" || d.severity === "error")
			.map((d) => d.title);

		// Extract suggested approaches
		const suggestedApproaches = allDiscoveries
			.filter((d) => d.kind === "suggested_approach")
			.map((d) => d.details);

		// Extract relevant files
		const relevantFiles = allDiscoveries
			.filter((d) => d.file)
			.map((d) => d.file!);

		// Build summary
		const insights: string[] = [];

		if (explorationDiscoveries.length > 0) {
			insights.push(
				`${explorationDiscoveries.length} exploration insights from prior arms.`,
			);
		}

		const missingContext = allDiscoveries.filter(
			(d) => d.kind === "missing_context",
		);
		if (missingContext.length > 0) {
			insights.push(
				`Missing context identified: ${missingContext.map((d) => d.title).join(", ")}.`,
			);
		}

		const ambiguous = allDiscoveries.filter(
			(d) => d.kind === "ambiguous_requirement",
		);
		if (ambiguous.length > 0) {
			insights.push(
				`Ambiguous requirements: ${ambiguous.map((d) => d.title).join(", ")}.`,
			);
		}

		const hasCriticalIssues = allDiscoveries.some(
			(d) => d.severity === "error" || d.kind === "potential_blocker",
		);

		return {
			relevantInsights:
				insights.length > 0
					? insights.join(" ")
					: "No prior discoveries directly relevant to this task.",
			blockers: [...new Set(blockers)],
			suggestedApproaches: [...new Set(suggestedApproaches)],
			relevantFiles: [...new Set(relevantFiles)],
			hasCriticalIssues,
			reasoning: "Fallback: extracted key information without LLM",
		};
	}

	private emptyResult(): DiscoverySummary {
		return {
			relevantInsights: "No prior discoveries available for this task.",
			blockers: [],
			suggestedApproaches: [],
			relevantFiles: [],
			hasCriticalIssues: false,
		};
	}

	private normalizeResult(result: Partial<DiscoverySummary>): DiscoverySummary {
		return {
			relevantInsights: result.relevantInsights || "No summary available.",
			blockers: result.blockers || [],
			suggestedApproaches: result.suggestedApproaches || [],
			relevantFiles: result.relevantFiles || [],
			hasCriticalIssues: result.hasCriticalIssues || false,
			reasoning: result.reasoning,
		};
	}
}

/**
 * Format a discovery summary for inclusion in a context bundle
 */
export function formatDiscoverySummary(summary: DiscoverySummary): string {
	const sections: string[] = [];

	// Main insights
	sections.push(`## PRIOR DISCOVERIES SUMMARY\n${summary.relevantInsights}`);

	// Blockers
	if (summary.blockers.length > 0) {
		sections.push(
			`### Known Blockers\n${summary.blockers.map((b) => `- ${b}`).join("\n")}`,
		);
	}

	// Suggested approaches
	if (summary.suggestedApproaches.length > 0) {
		sections.push(
			`### Suggested Approaches\n${summary.suggestedApproaches.map((a) => `- ${a}`).join("\n")}`,
		);
	}

	// Relevant files
	if (summary.relevantFiles.length > 0) {
		sections.push(
			`### Files to Review\n${summary.relevantFiles.map((f) => `- ${f}`).join("\n")}`,
		);
	}

	// Critical issues warning
	if (summary.hasCriticalIssues) {
		sections.push(
			`### WARNING: Critical Issues\nThere are critical blockers or errors identified. Review the blockers section before proceeding.`,
		);
	}

	return sections.join("\n\n");
}
