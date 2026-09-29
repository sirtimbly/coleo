import { taskPreparationSchema } from "../../types/task-handoff";
import { API_BASE_URL, API_KEY, ARM_ID, logActivity } from "../utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaskPreparation, PreparedTaskResponse } from "../../types/task-handoff";

interface PreparationOptions {
	baseUrl: string;
	apiKey: string;
	armId: string;
	fetchFn?: typeof fetch;
}

/** Use the API's atomic preparation operation, including remote arm hosts. */
export async function prepareTaskForHandoff(
	input: TaskPreparation,
	options: PreparationOptions,
): Promise<PreparedTaskResponse> {
	const response = await (options.fetchFn ?? fetch)(`${options.baseUrl}/api/tasks/prepared`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-API-Key": options.apiKey },
		body: JSON.stringify({ ...input, preparedBy: options.armId }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => null) as { error?: unknown } | null;
		throw new Error(typeof body?.error === "string" ? body.error : `Task preparation failed (HTTP ${response.status})`);
	}
	return await response.json() as PreparedTaskResponse;
}

export function registerPrepareTaskTool(server: McpServer): void {
	server.registerTool("prepare_task", {
		description: "Prepare a detailed draft with plan provenance and queue it for dependency-aware Brain activation. Preparation does not assign work or make it immediately claimable.",
		inputSchema: taskPreparationSchema.shape,
	}, async (input) => {
		try {
			const { task, handoff } = await prepareTaskForHandoff(input, {
				baseUrl: API_BASE_URL, apiKey: API_KEY, armId: ARM_ID,
			});
			logActivity(ARM_ID, "prepare_task", task.id, { subject: task.subject, handoffId: handoff.id });
			return { content: [{ type: "text" as const, text:
				`Task prepared successfully!\n\nID: ${task.id}\nSubject: ${task.subject}\nStatus: ${task.status}\nPriority: ${task.priority}\nPrepared by: ${ARM_ID}\n\nQueued for Brain activation after planning and dependency checks. Other arms can claim it once it becomes pending.`,
			}] };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logActivity(ARM_ID, "prepare_task_error", undefined, { error: message });
			return { content: [{ type: "text" as const, text: `Failed to prepare task: ${message}` }], isError: true };
		}
	});
}
