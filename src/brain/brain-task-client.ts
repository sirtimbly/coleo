import type { Task, StatusReport } from "../types";
import type { ApiClientOptions } from "./brain-api-client";
import { apiRequest } from "./brain-api-client";

export interface TaskListOptions {
	status?: string;
	assignedTo?: string;
	domain?: string;
	classification?: string;
	limit?: number;
	offset?: number;
}

export async function listTasksFromApi(
	apiOptions: ApiClientOptions,
	options?: TaskListOptions,
): Promise<Task[]> {
	const params = new URLSearchParams();
	if (options?.status) params.set("status", options.status);
	if (options?.assignedTo) params.set("assignedTo", options.assignedTo);
	if (options?.domain) params.set("domain", options.domain);
	if (options?.classification) params.set("classification", options.classification);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.offset) params.set("offset", String(options.offset));

	const query = params.toString();
	const endpoint = query ? `/api/tasks?${query}` : "/api/tasks";

	const result = await apiRequest<{ tasks: Task[] }>({
		...apiOptions,
		endpoint,
	});

	return result?.tasks || [];
}

export async function getTaskFromApi(
	apiOptions: ApiClientOptions,
	taskId: string,
): Promise<Task | null> {
	return await apiRequest<Task>({
		...apiOptions,
		endpoint: `/api/tasks/${taskId}`,
	});
}

export interface TaskCreateInput {
	id: string;
	subject: string;
	description: string;
	status?: string;
	priority?: string;
	domain?: string;
	classification?: string;
	mailThreadId?: string;
	context?: Task["context"];
	sourceType?: string;
	assignedTo?: string;
	dependencies?: string[];
}

export async function createTaskViaApi(
	apiOptions: ApiClientOptions,
	input: TaskCreateInput,
): Promise<Task | null> {
	return await apiRequest<Task>({
		...apiOptions,
		endpoint: "/api/tasks",
		method: "POST",
		body: JSON.stringify(input),
	});
}

export interface TaskPatchInput {
	subject?: string;
	description?: string;
	status?: string;
	priority?: string;
	domain?: string;
	classification?: string;
	assignedTo?: string;
	dependencies?: string[];
	orderKey?: string;
	sortOrder?: number;
}

export async function patchTaskViaApi(
	apiOptions: ApiClientOptions,
	taskId: string,
	input: TaskPatchInput,
): Promise<Task | null> {
	return await apiRequest<Task>({
		...apiOptions,
		endpoint: `/api/tasks/${taskId}`,
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export async function getTaskDependenciesFromApi(
	apiOptions: ApiClientOptions,
	taskId: string,
): Promise<string[]> {
	const result = await apiRequest<{ dependencies: string[] }>({
		...apiOptions,
		endpoint: `/api/tasks/${taskId}/dependencies`,
	});

	return result?.dependencies || [];
}

export async function getTaskSubjectFromApi(
	apiOptions: ApiClientOptions,
	taskId: string,
): Promise<string> {
	const task = await getTaskFromApi(apiOptions, taskId);
	return task?.subject || taskId;
}

export async function moveTaskToTop(
	apiOptions: ApiClientOptions,
	taskId: string,
): Promise<boolean> {
	const result = await apiRequest<{ success: boolean }>({
		...apiOptions,
		endpoint: `/api/tasks/${taskId}/move-to-top`,
		method: "POST",
	});

	return result?.success ?? false;
}

export interface StatusReportListOptions {
	taskId?: string;
	armId?: string;
	status?: string;
	limit?: number;
	offset?: number;
}

export async function listStatusReportsFromApi(
	apiOptions: ApiClientOptions,
	options?: StatusReportListOptions,
): Promise<StatusReport[]> {
	const params = new URLSearchParams();
	if (options?.taskId) params.set("taskId", options.taskId);
	if (options?.armId) params.set("armId", options.armId);
	if (options?.status) params.set("status", options.status);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.offset) params.set("offset", String(options.offset));

	const query = params.toString();
	const endpoint = query ? `/api/status-reports?${query}` : "/api/status-reports";

	const result = await apiRequest<{ reports: StatusReport[] }>({
		...apiOptions,
		endpoint,
	});

	return result?.reports || [];
}

export interface TaskDiscussionMessage {
	id: string;
	taskId: string;
	author: string;
	content: string;
	timestamp: string;
}

export async function getTaskDiscussionFromApi(
	apiOptions: ApiClientOptions,
	taskId: string,
): Promise<TaskDiscussionMessage[]> {
	const result = await apiRequest<{ messages: TaskDiscussionMessage[] }>({
		...apiOptions,
		endpoint: `/api/tasks/${taskId}/discussion`,
	});

	return result?.messages || [];
}

export async function getTaskDiscussionText(
	apiOptions: ApiClientOptions,
	taskId: string,
): Promise<string> {
	const messages = await getTaskDiscussionFromApi(apiOptions, taskId);
	return messages
		.map((m) => `[${m.author}]: ${m.content}`)
		.join("\n\n");
}

export interface TaskCommentInput {
	taskId: string;
	author: string;
	content: string;
}

export async function appendTaskCommentViaApi(
	apiOptions: ApiClientOptions,
	input: TaskCommentInput,
): Promise<void> {
	await apiRequest({
		...apiOptions,
		endpoint: `/api/tasks/${input.taskId}/discussion`,
		method: "POST",
		body: JSON.stringify({
			author: input.author,
			content: input.content,
		}),
	});
}

export interface TaskCompletionResult {
	taskId: string;
	success: boolean;
	validationRequired: boolean;
	validatorId?: string;
}

export async function completeTaskViaApi(
	apiOptions: ApiClientOptions,
	taskId: string,
	summary: string,
	artifacts?: string[],
): Promise<TaskCompletionResult | null> {
	return await apiRequest<TaskCompletionResult>({
		...apiOptions,
		endpoint: `/api/tasks/${taskId}/complete`,
		method: "POST",
		body: JSON.stringify({ summary, artifacts }),
	});
}
