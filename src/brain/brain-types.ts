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

export function pathMatchesPattern(filePath: string, pattern: string): boolean {
	const normalizedPath = filePath.replaceAll("\\", "/");
	const normalizedPattern = pattern.replaceAll("\\", "/");

	if (normalizedPattern === "**" || normalizedPattern === "*") {
		return true;
	}

	if (!normalizedPattern.includes("*")) {
		return normalizedPath.includes(normalizedPattern);
	}

	const tokenDouble = "__DOUBLE_STAR__";
	const tokenSingle = "__SINGLE_STAR__";
	const escaped = normalizedPattern
		.replaceAll("**", tokenDouble)
		.replaceAll("*", tokenSingle)
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replaceAll(tokenDouble, ".*")
		.replaceAll(tokenSingle, "[^/]*");

	const regex = new RegExp(`^${escaped}$`);
	return regex.test(normalizedPath);
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

export interface DocUpdateContext {
	filesChanged: string[];
	changedFilesCount: number;
	featureDocsToUpdate: string[];
	planDocument?: string;
}

export interface LargeFile {
	path: string;
	lines: number;
}

export function buildDocUpdateDescription(context: DocUpdateContext): string {
	let desc = `## Documentation Update Task

This task ensures feature documentation remains aligned with actual code implementation.

### Files Changed Since Last Update
${context.changedFilesCount} files have been modified:
${context.filesChanged
	.slice(0, 10)
	.map((f) => `- ${f}`)
	.join("\n")}
${context.filesChanged.length > 10 ? `- ... and ${context.filesChanged.length - 10} more` : ""}

### Feature Docs to Review
${
	context.featureDocsToUpdate.length > 0
		? context.featureDocsToUpdate.map((d) => `- ${d}`).join("\n")
		: "No specific feature docs identified - review general docs for accuracy."
}

### Your Tasks

1. **Review changed files** - Understand what code changes were made
2. **Update feature docs** - Ensure docs/features/, docs/api/, and docs/capabilities/ match implementation
3. **Add "Future Work" notes** - For features documented but not yet implemented:
   - Mark as "Planned for Phase N"
   - Reference the plan document
4. **Do NOT update** - Conceptual docs, architecture decisions, or requirements

### Output
When complete, report:
- Which docs were updated
- Any "Future Work" notes added
- Any features that need attention

`;

	if (context.planDocument) {
		desc += `### Reference\nSee \`${context.planDocument}\` for planned features that may need "Future Work" notes.\n`;
	}

	return desc;
}


