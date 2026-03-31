/**
 * Stuck Arm Analyzer
 * 
 * LLM-based analyzer that analyzes PTY output to determine if an arm is stuck
 * and suggests appropriate actions.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import nunjucks from "nunjucks";
import type { StuckAnalysis } from "./activity-types";
import { resolveLogFn } from "./activity-types";

/**
 * LLM-based Stuck Arm Analyzer
 * Analyzes PTY output to determine if an arm is stuck and suggests actions
 */
export class StuckArmAnalyzer {
	private apiKey: string;
	private model: string;
	private baseUrl: string;
	private logger: (message: string) => void;
	private templateDir: string;

	constructor(
		logger: (message: string) => void,
		coleoDir: string = process.cwd(),
	) {
		this.logger = resolveLogFn(logger);
		this.apiKey = process.env.OPENAI_API_KEY || "";
		this.model = process.env.OPENAI_MODEL || "gpt-5-mini";
		this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
		this.templateDir = join(coleoDir, "src", "brain", "templates");
	}

	private async renderTemplate(
		templateName: string,
		context: Record<string, unknown>,
	): Promise<string | null> {
		const templatePath = join(this.templateDir, templateName);
		try {
			const templateContent = await readFile(templatePath, "utf-8");
			return nunjucks.renderString(templateContent, context);
		} catch (err) {
			this.logger(
				`[stuck-analyzer] Failed to load template ${templateName}: ${err}`,
			);
			return null;
		}
	}

	/**
	 * Analyze arm output to determine if it's stuck
	 */
	async analyze(
		armName: string,
		armDomain: string,
		recentOutput: string,
		currentTask?: string,
	): Promise<StuckAnalysis> {
		// Quick heuristics first (avoid LLM calls when possible)
		const quickResult = this.quickAnalysis(recentOutput);
		if (quickResult) {
			return quickResult;
		}

		// Use LLM for deeper analysis
		if (!this.apiKey) {
			return this.fallbackAnalysis(recentOutput);
		}

		const systemPrompt = await this.renderTemplate(
			"stuck-analyzer-system-prompt.jinja",
			{
				arm_name: armName,
				arm_domain: armDomain,
				current_task: currentTask || "unknown",
			},
		);

		const userMessage = await this.renderTemplate(
			"stuck-analyzer-user-prompt.jinja",
			{
				recent_output: recentOutput.slice(-8000),
			},
		);

		if (!systemPrompt || !userMessage) {
			return this.fallbackAnalysis(recentOutput);
		}

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
					max_completion_tokens: userMessage.length + 2500,
				}),
			});

			if (!response.ok) {
				const err = await response.text();
				this.logger(
					`[stuck-analyzer] OpenAI API error: ${err.substring(0, 200)}`,
				);
				return this.fallbackAnalysis(recentOutput);
			}

			const data = (await response.json()) as {
				choices: Array<{ message: { content: string } }>;
			};
			const content = data.choices[0]?.message?.content || "";

			// Parse JSON from response
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const result = JSON.parse(jsonMatch[0]) as StuckAnalysis;
				this.logger(
					`[stuck-analyzer] LLM analysis for ${armName}: stuck=${result.isStuck}, type=${result.stuckType}, confidence=${result.confidence}`,
				);
				return result;
			}

			return this.fallbackAnalysis(recentOutput);
		} catch (err) {
			this.logger(`[stuck-analyzer] LLM analysis error: ${err}`);
			return this.fallbackAnalysis(recentOutput);
		}
	}

	/**
	 * Analyze if an arm has silently completed its task without calling complete_task
	 */
	async analyzeSilentCompletion(
		armName: string,
		recentOutput: string,
		statusReports: Array<{
			status: string;
			summary: string;
			issues?: string[];
			testsStatus?: "passing" | "failing" | "not_run";
			filesChanged?: string[];
		}>,
		taskDescription?: string,
	): Promise<StuckAnalysis | null> {
		// Check if we have recent status reports indicating completion
		if (!statusReports || statusReports.length === 0) {
			return null;
		}

		const latestReport = statusReports[statusReports.length - 1];
		if (!latestReport) {
			return null;
		}

		// Criteria for silent completion:
		// 1. Status is "on_track" or "completed_with_issues" but not explicitly completed
		// 2. Tests are passing
		// 3. No blockers or critical issues
		// 4. Files have been changed
		// 5. Arm appears to be idle or waiting

		const isOnTrack = latestReport.status === "on_track";
		const isCompletedWithIssues = latestReport.status === "completed_with_issues";
		const testsPassing = latestReport.testsStatus === "passing";
		const noCriticalIssues = !latestReport.issues || latestReport.issues.length === 0;
		const hasFilesChanged = latestReport.filesChanged && latestReport.filesChanged.length > 0;

		// Check if output indicates waiting state
		const lines = recentOutput.trim().split("\n");
		const lastLines = lines.slice(-10).join("\n").toLowerCase();
		const waitingPatterns = [
			/waiting for/i,
			/awaiting/i,
			/paused/i,
			/idle/i,
			/done\?/i,
			/finished\?/i,
			/complete\?/i,
		];
		const appearsWaiting = waitingPatterns.some(p => p.test(lastLines));

		// Calculate confidence based on criteria met
		let confidence = 0;
		if (isOnTrack || isCompletedWithIssues) confidence += 0.3;
		if (testsPassing) confidence += 0.25;
		if (noCriticalIssues) confidence += 0.2;
		if (hasFilesChanged) confidence += 0.15;
		if (appearsWaiting) confidence += 0.1;

		// If confidence is high enough, report silent completion
		if (confidence >= 0.6) {
			return {
				isStuck: true,
				stuckType: "silent_completion",
				reasoning: `Arm appears to have completed work but hasn't called complete_task. ` +
					`Status: ${latestReport.status}, tests: ${latestReport.testsStatus || "unknown"}, ` +
					`files changed: ${latestReport.filesChanged?.length || 0}`,
				suggestedAction: "prompt_complete_task",
				confidence,
				silentCompletion: {
					taskId: "unknown", // Will be filled in by brain
					filesChanged: latestReport.filesChanged || [],
					testsStatus: latestReport.testsStatus,
					isReadyForCompletion: confidence >= 0.75,
				},
			};
		}

		return null;
	}

	/**
	 * Quick heuristic analysis (avoids LLM call)
	 */
	private quickAnalysis(output: string): StuckAnalysis | null {
		const lines = output.trim().split("\n");
		const lastLines = lines.slice(-20).join("\n").toLowerCase();

		// Check for obvious question patterns
		// Only match patterns that indicate the arm is truly waiting for input, not just
		// generating text that happens to contain question-like phrases
		const questionPatterns = [
			/\?\s*$/m, // Line ends with ?
			/\(y\/n\)\s*$/im, // (y/n) at end of line
			/\[y\/n\]\s*$/im, // [y/n] at end of line
			/yes or no\?/i,
			/please (choose|select|confirm|specify)\b/i,
			// Only match "enter:" at the very end of output, preceded by a prompt-like pattern
			/[>$&#]\s*enter\s*:/i,
			/^\s*enter\s*:/im, // "Enter:" at start of a line (after whitespace)
		];

		for (const pattern of questionPatterns) {
			if (pattern.test(lastLines)) {
				return {
					isStuck: true,
					stuckType: "asking_question",
					reasoning: `Output matches question pattern: ${pattern}`,
					suggestedAction: "answer",
					confidence: 0.8,
				};
			}
		}

		// Check for approval patterns
		const approvalPatterns = [
			/approve.*\?/i,
			/proceed.*\?/i,
			/continue.*\?/i,
			/confirm.*\?/i,
		];

		for (const pattern of approvalPatterns) {
			if (pattern.test(lastLines)) {
				return {
					isStuck: true,
					stuckType: "waiting_approval",
					reasoning: `Output matches approval pattern: ${pattern}`,
					suggestedAction: "approve",
					suggestedResponse: "Yes, proceed.",
					confidence: 0.85,
				};
			}
		}

		// Check for repeated errors (looping)
		const errorCounts = new Map<string, number>();
		for (const line of lines.slice(-50)) {
			if (/error|failed|exception/i.test(line)) {
				const normalized = line.toLowerCase().replace(/\d+/g, "N").trim();
				errorCounts.set(normalized, (errorCounts.get(normalized) || 0) + 1);
			}
		}

		for (const [error, count] of errorCounts) {
			if (count >= 3) {
				return {
					isStuck: true,
					stuckType: "looping",
					reasoning: `Same error repeated ${count} times: ${error.slice(0, 50)}...`,
					suggestedAction: "compact",
					confidence: 0.75,
				};
			}
		}

		return null; // Need deeper analysis
	}

	/**
	 * Fallback analysis when LLM is unavailable
	 */
	private fallbackAnalysis(output: string): StuckAnalysis {
		const lines = output.trim().split("\n");
		const lastLine = lines[lines.length - 1] || "";

		// Very basic heuristics
		if (lastLine.includes("?") || lastLine.toLowerCase().includes("input")) {
			return {
				isStuck: true,
				stuckType: "asking_question",
				reasoning: "Last line appears to be a question (fallback)",
				suggestedAction: "escalate",
				confidence: 0.5,
			};
		}

		// If output is very short or empty, might be idle
		if (output.trim().length < 100) {
			return {
				isStuck: false,
				reasoning: "Output too short to determine (fallback)",
				confidence: 0.3,
			};
		}

		return {
			isStuck: false,
			reasoning: "No obvious stuck patterns detected (fallback)",
			confidence: 0.4,
		};
	}
}
