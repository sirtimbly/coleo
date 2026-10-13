import type { Bug, Task } from "../types";
import type { ApiClientOptions } from "./brain-api-client";

export interface BugListOptions {
	status?: string;
	priority?: string;
	source?: string;
	assignedTo?: string;
	limit?: number;
	offset?: number;
}

export async function listBugsFromApi(
	apiOptions: ApiClientOptions,
	options?: BugListOptions,
): Promise<Bug[]> {
	const params = new URLSearchParams();
	if (options?.status) params.set("status", options.status);
	if (options?.priority) params.set("priority", options.priority);
	if (options?.source) params.set("source", options.source);
	if (options?.assignedTo) params.set("assignedTo", options.assignedTo);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.offset) params.set("offset", String(options.offset));

	const query = params.toString();
	const endpoint = query ? `/api/bugs?${query}` : "/api/bugs";

	const { apiRequest } = await import("./brain-api-client");
	const result = await apiRequest<{ bugs: Bug[] }>({
		...apiOptions,
		endpoint,
	});

	return result?.bugs || [];
}

export async function getBugFromApi(
	apiOptions: ApiClientOptions,
	bugId: string,
): Promise<Bug | null> {
	const { apiRequest } = await import("./brain-api-client");
	return await apiRequest<Bug>({
		...apiOptions,
		endpoint: `/api/bugs/${bugId}`,
	});
}

export interface BugCreateInput {
	id: string;
	title: string;
	description: string;
	source: "arm_reported" | "human_reported" | "system_detected";
	sourceTaskId?: string;
	errorDetails?: string;
	priority?: string;
}

export async function createBugViaApi(
	apiOptions: ApiClientOptions,
	input: BugCreateInput,
): Promise<Bug | null> {
	const { apiRequest } = await import("./brain-api-client");
	return await apiRequest<Bug>({
		...apiOptions,
		endpoint: "/api/bugs",
		method: "POST",
		body: JSON.stringify(input),
	});
}

export interface BugPatchInput {
	title?: string;
	description?: string;
	status?: string;
	priority?: string;
	assignee?: string;
	resolution?: string;
}

export async function patchBugViaApi(
	apiOptions: ApiClientOptions,
	bugId: string,
	input: BugPatchInput,
): Promise<Bug | null> {
	const { apiRequest } = await import("./brain-api-client");
	return await apiRequest<Bug>({
		...apiOptions,
		endpoint: `/api/bugs/${bugId}`,
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export async function claimBugViaApi(
	apiOptions: ApiClientOptions,
	bugId: string,
	armId: string,
): Promise<boolean> {
	const { apiRequest } = await import("./brain-api-client");
	const result = await apiRequest<{ success: boolean }>({
		...apiOptions,
		endpoint: `/api/bugs/${bugId}/claim`,
		method: "POST",
		body: JSON.stringify({ armId }),
	});

	return result?.success ?? false;
}

export interface BugDeduplicationResult {
	bugId: string;
	deduplicated: boolean;
	existingBugId?: string;
}

export async function checkBugDuplicateViaApi(
	apiOptions: ApiClientOptions,
	title: string,
): Promise<BugDeduplicationResult | null> {
	const { apiRequest } = await import("./brain-api-client");
	return await apiRequest<BugDeduplicationResult>({
		...apiOptions,
		endpoint: "/api/bugs/check-duplicate",
		method: "POST",
		body: JSON.stringify({ title }),
	});
}

export function determineBugPriority(
	description: string,
	source: string,
): "critical" | "high" | "medium" | "low" {
	const lowerDesc = description.toLowerCase();

	if (lowerDesc.includes("crash") || lowerDesc.includes("data loss") || lowerDesc.includes("security")) {
		return "critical";
	}

	if (lowerDesc.includes("blocked") || lowerDesc.includes("cannot") || lowerDesc.includes("failing")) {
		return "high";
	}

	if (lowerDesc.includes("should") || lowerDesc.includes("feature") || lowerDesc.includes("improvement")) {
		return "medium";
	}

	return "low";
}

export function shouldCreateInvestigationTask(bug: Bug): boolean {
	return (
		(bug.priority === "critical" || bug.priority === "high") &&
		bug.status === "open" &&
		!bug.assigneeArmId
	);
}

export function shouldEscalateBug(bug: Bug, hoursSinceCreated: number): boolean {
	const escalationThresholds = {
		critical: 1,
		high: 4,
		medium: 24,
		low: 72,
	};

	const threshold = escalationThresholds[bug.priority as keyof typeof escalationThresholds] || 24;
	return hoursSinceCreated > threshold && bug.status !== "resolved" && bug.status !== "closed";
}

export function formatBugReport(bug: Bug, includeDetails = false): string {
	const statusEmoji = {
		open: "🔴",
		investigating: "🔍",
		fixing: "🔧",
		verifying: "✅",
		resolved: "✓",
		closed: "📋",
	}[bug.status] || "❓";

	const priorityEmoji = {
		critical: "🚨",
		high: "⚠️",
		medium: "📌",
		low: "💬",
	}[bug.priority] || "❓";

	let report = `${statusEmoji} ${priorityEmoji} **${bug.title}** (${bug.id})`;

	if (includeDetails) {
		report += `\n\n**Status**: ${bug.status}\n`;
		report += `**Priority**: ${bug.priority}\n`;
		report += `**Source**: ${bug.source}\n`;
		if (bug.assigneeArmId) {
			report += `**Assigned**: ${bug.assigneeArmId}\n`;
		}
		if (bug.description) {
			report += `\n**Description**:\n${bug.description}\n`;
		}
	}

	return report;
}
