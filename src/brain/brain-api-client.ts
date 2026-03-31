export interface ApiClientOptions {
	baseUrl: string;
	apiKey: string;
	timeout?: number;
}

export interface ApiResponse<T> {
	data?: T;
	error?: string;
	status: number;
}

export async function apiRequest<T>(
	options: ApiClientOptions & {
		endpoint: string;
		method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		body?: string;
	},
): Promise<T | null> {
	const { baseUrl, apiKey, endpoint, method = "GET", body, timeout = 30000 } = options;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(`${baseUrl}${endpoint}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error(`API authentication failed: ${response.status}`);
			}
			if (response.status === 404) {
				return null;
			}
			throw new Error(`API request failed: ${response.status}`);
		}

		if (response.status === 204) {
			return null;
		}

		return (await response.json()) as T;
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`API request timed out after ${timeout}ms`);
		}
		throw error;
	}
}

export interface ActivityEntry {
	id: string;
	actor: string;
	action: string;
	target?: string;
	details?: Record<string, unknown>;
	timestamp: string;
}

export async function logActivityViaApi(
	options: ApiClientOptions,
	actor: string,
	action: string,
	target?: string,
	details?: Record<string, unknown>,
): Promise<void> {
	await apiRequest({
		...options,
		endpoint: "/api/activity",
		method: "POST",
		body: JSON.stringify({
			actor,
			action,
			target,
			details: details || {},
		}),
	});
}

export interface EventPublishPayload {
	type: string;
	arm_id?: string;
	task_id?: string;
	data: Record<string, unknown>;
}

export async function publishEventViaApi(
	options: ApiClientOptions,
	event: EventPublishPayload,
): Promise<void> {
	await apiRequest({
		...options,
		endpoint: "/api/events",
		method: "POST",
		body: JSON.stringify(event),
	});
}

export async function queueMessageViaApi(
	options: ApiClientOptions,
	input: {
		to: string;
		type: string;
		payload: Record<string, unknown>;
		replyTo?: string;
		priority?: number;
	},
): Promise<void> {
	await apiRequest({
		...options,
		endpoint: "/api/queue",
		method: "POST",
		body: JSON.stringify(input),
	});
}

export interface QueueMessageItem {
	id: string;
	from: string;
	to: string;
	type: string;
	payload: Record<string, unknown>;
	status: string;
	createdAt: string;
}

export async function listPendingMessagesViaApi(
	options: ApiClientOptions,
	to?: string,
	limit = 100,
): Promise<QueueMessageItem[]> {
	const params = new URLSearchParams();
	if (to) params.set("to", to);
	params.set("limit", String(limit));
	params.set("status", "pending");

	const result = await apiRequest<{ messages: QueueMessageItem[] }>({
		...options,
		endpoint: `/api/queue?${params.toString()}`,
	});

	return result?.messages || [];
}

export async function markMessageStatusViaApi(
	options: ApiClientOptions,
	messageId: string,
	status: "processed" | "failed",
): Promise<void> {
	await apiRequest({
		...options,
		endpoint: `/api/queue/${messageId}/status`,
		method: "PATCH",
		body: JSON.stringify({ status }),
	});
}

export async function cleanupMessagesViaApi(
	options: ApiClientOptions,
	olderThanDays = 7,
): Promise<void> {
	await apiRequest({
		...options,
		endpoint: `/api/queue/cleanup?olderThanDays=${olderThanDays}`,
		method: "POST",
	});
}

export interface FileChangeRecord {
	file_path: string;
	change_type: "created" | "modified" | "deleted";
	summary: string;
	arm_id?: string;
	timestamp: string;
}

export async function recordFileChangeViaApi(
	options: ApiClientOptions,
	input: {
		armId?: string;
		filePath: string;
		changeType: "created" | "modified" | "deleted";
		summary: string;
	},
): Promise<void> {
	await apiRequest({
		...options,
		endpoint: "/api/file-changes",
		method: "POST",
		body: JSON.stringify({
			arm_id: input.armId,
			file_path: input.filePath,
			change_type: input.changeType,
			summary: input.summary,
		}),
	});
}

export function createApiClient(baseUrl: string, apiKey: string): ApiClientOptions {
	return { baseUrl, apiKey };
}
