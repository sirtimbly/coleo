import type { Arm, Task, Discovery, QueueMessage, TaskAttachment } from "../types";

export interface BrainOptions {
	coleoDir: string;
	pollIntervalMs: number;
	verbose: boolean;
	apiBaseUrl?: string;
	apiKey?: string;
}

export interface TaskClaimContext {
	armId: string;
	taskId: string;
	armDomain?: string;
}

export interface BugReportPayload {
	id: string;
	title: string;
	description: string;
	source: "arm_reported" | "human_reported" | "system_detected";
	sourceTaskId?: string;
	errorDetails?: string;
}

export interface StatusReportPayload {
	task_id: string;
	status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
	summary: string;
	blockers?: string[];
	issues?: string[];
	files_changed?: string[];
	next_steps?: string;
	screenshot_path?: string;
	tests_status?: "passing" | "failing" | "not_run";
}

export interface DiscoveryPayload {
	kind: string;
	title: string;
	details: string;
	task_id?: string;
	file?: string;
	line?: number;
	severity?: "info" | "warning" | "error";
	phase?: "exploration" | "implementation" | "verification";
}

export interface FileSubscriptionPayload {
	category?: string;
	pattern: string;
}

export interface FileChangePayload {
	file_path: string;
	change_type: "created" | "modified" | "deleted";
	summary: string;
	impact?: string;
}

export function isTaskAttachment(value: unknown): value is TaskAttachment {
	if (!value || typeof value !== "object") {
		return false;
	}
	const attachment = value as Partial<TaskAttachment>;
	return (
		attachment.kind === "image" &&
		typeof attachment.uploadId === "string" &&
		typeof attachment.filename === "string" &&
		typeof attachment.mimeType === "string" &&
		typeof attachment.sizeBytes === "number" &&
		typeof attachment.contentUrl === "string"
	);
}

export function pathMatchesPattern(path: string, pattern: string): boolean {
	if (pattern.includes("*")) {
		const regexPattern = pattern
			.replace(/\./g, "\\.")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*");
		return new RegExp(`^${regexPattern}$`).test(path);
	}
	return path === pattern || path.startsWith(pattern + "/");
}

export function isProductiveAction(action: string): boolean {
	const productiveActions = [
		"file_read",
		"file_write",
		"file_edit",
		"bash_command",
		"tool_call",
		"task_claimed",
		"task_completed",
		"status_report",
		"discovery_reported",
		"bug_reported",
	];
	return productiveActions.some((a) => action.toLowerCase().includes(a.toLowerCase()));
}

export function analyzePromptResponsePattern(
	promptCount: number,
	lastPromptAt: Date,
	lastProductiveAt: Date | null,
	escalationLevel: number,
): { isStuck: boolean; reason: string; suggestedAction: string } {
	const timeSinceLastPrompt = Date.now() - lastPromptAt.getTime();
	const gracePeriodMs = 5 * 60 * 1000; // 5 minutes

	if (timeSinceLastPrompt < gracePeriodMs) {
		return { isStuck: false, reason: "Within grace period", suggestedAction: "wait" };
	}

	if (lastProductiveAt === null && promptCount >= 3) {
		return {
			isStuck: true,
			reason: `No productive activity after ${promptCount} prompts`,
			suggestedAction: escalationLevel < 2 ? "interrupt" : "kill",
		};
	}

	if (lastProductiveAt) {
		const timeSinceProductive = Date.now() - lastProductiveAt.getTime();
		const stuckThresholdMs = 15 * 60 * 1000; // 15 minutes

		if (timeSinceProductive > stuckThresholdMs && promptCount >= 2) {
			return {
				isStuck: true,
				reason: `No productive activity for ${Math.floor(timeSinceProductive / 60000)} minutes`,
				suggestedAction: "compact",
			};
		}
	}

	return { isStuck: false, reason: "Normal operation", suggestedAction: "continue" };
}

export function getArmDisplayName(armId: string, arms: Map<string, Arm>): string {
	const arm = arms.get(armId);
	return arm?.name || armId;
}

export function buildDocUpdateDescription(
	subject: string,
	description: string,
	targetDoc?: string,
): string {
	if (targetDoc) {
		return `Update documentation: docs/${targetDoc}\n\n${description}`;
	}
	return `Update project documentation based on human feedback:\n\n${description}`;
}

export function buildRefactoringDescription(
	largeFiles: Array<{ path: string; lines: number }>,
	threshold: number,
): string {
	const fileLines = largeFiles
		.map((f) => `- ${f.path}: ${f.lines} lines (threshold: ${threshold})`)
		.join("\n");

	return `The following files exceed ${threshold} lines and should be refactored:

${fileLines}

**Guidelines:**
- Extract utilities, types, and helper functions into focused modules
- Maintain backward compatibility by re-exporting from original files
- Target ~300 lines per module for maintainability
- Avoid circular dependencies between modules
`;
}
