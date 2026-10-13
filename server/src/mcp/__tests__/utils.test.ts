import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { TaskDeterminationResult } from "../../brain/prompt-generator";
import { access, rm, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildTaskDeterminationOptionsForArm,
  clearRecentCompletedTaskExclusion,
  COLEO_DIR,
  sendToBrain,
  getRecentCompletedTaskIdForExclusion,
  API_BASE_URL,
  API_KEY,
  rememberRecentlyCompletedTask,
  updateCompletionExclusionAfterDetermination,
} from "../utils";

function makeDeterminationResult(taskId?: string): TaskDeterminationResult {
  if (!taskId) {
    return {} as TaskDeterminationResult;
  }
  return {
    task: { id: taskId },
  } as TaskDeterminationResult;
}

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof spyOn> | null = null;
const originalPublishMode = process.env.COLEO_MCP_COMMAND_PUBLISH_MODE;

afterEach(() => {
  clearRecentCompletedTaskExclusion();
	if (fetchSpy) {
		fetchSpy.mockRestore();
		fetchSpy = null;
	}
	globalThis.fetch = originalFetch;
	if (originalPublishMode === undefined) {
		delete process.env.COLEO_MCP_COMMAND_PUBLISH_MODE;
	} else {
		process.env.COLEO_MCP_COMMAND_PUBLISH_MODE = originalPublishMode;
	}
});

describe("MCP completion exclusion helpers", () => {
  it("tracks a recently completed task for subsequent determination calls", () => {
    rememberRecentlyCompletedTask("  task-123  ");

    expect(getRecentCompletedTaskIdForExclusion()).toBe("task-123");
    expect(buildTaskDeterminationOptionsForArm()).toEqual({
      excludeTaskIds: ["task-123"],
      excludeVerificationForTaskIds: ["task-123"],
    });
  });

  it("ignores blank task ids", () => {
    rememberRecentlyCompletedTask("   ");

    expect(getRecentCompletedTaskIdForExclusion()).toBeNull();
    expect(buildTaskDeterminationOptionsForArm()).toEqual({});
  });

  it("clears the exclusion once routing moves to a different task", () => {
    rememberRecentlyCompletedTask("task-123");

    updateCompletionExclusionAfterDetermination(makeDeterminationResult("task-456"));

    expect(getRecentCompletedTaskIdForExclusion()).toBeNull();
  });

  it("keeps the exclusion when the brain returns the same task again", () => {
    rememberRecentlyCompletedTask("task-123");

    updateCompletionExclusionAfterDetermination(makeDeterminationResult("task-123"));

    expect(getRecentCompletedTaskIdForExclusion()).toBe("task-123");
  });

	it("publishes commands to authoritative command API with expected envelope and headers", async () => {
		process.env.COLEO_MCP_COMMAND_PUBLISH_MODE = "api";

		let requestBody = "";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				expect(String(input)).toBe(
					`${API_BASE_URL}/api/brain/internal/commands/publish`,
				);
				expect(init?.method).toBe("POST");

				const headerEntries =
					init?.headers instanceof Headers
						? init.headers
					: Array.isArray(init?.headers)
							? init.headers
						: init?.headers
								? Object.entries(init.headers).map(([key, value]) => [
									key,
									Array.isArray(value) ? value.join(",") : String(value),
								])
								: [];

				const headers = new (globalThis.Headers as unknown as { new(init?: any): Headers })(
					headerEntries as any,
				);
				expect(headers.get("content-type")).toBe("application/json");
				expect(headers.get("x-api-key")).toBe(API_KEY);

				requestBody = String(init?.body ?? "{}");
				const body = JSON.parse(requestBody) as Record<string, unknown>;
				expect(body.from).toBe("arm-test");
				expect(body.to).toBe("brain");
				expect(body.type).toBe("task_complete");
				expect(body.payload).toEqual({ taskId: "task-1", summary: "done" });
				expect(typeof body.id).toBe("string");
				expect(typeof body.createdAt).toBe("string");
				expect(body.schemaVersion).toBe(1);

				return new Response(
					JSON.stringify({ accepted: true, id: body.id }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as typeof fetch,
		);

		const messageId = await sendToBrain({
			from: "arm-test",
			to: "brain",
			type: "task_complete",
			payload: { taskId: "task-1", summary: "done" },
		});

		const parsed = JSON.parse(requestBody) as { id: string };
		expect(parsed.id).toBe(messageId);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("falls back to compat queue API when command API publish fails", async () => {
		process.env.COLEO_MCP_COMMAND_PUBLISH_MODE = "api";

		let primaryBody = "";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const url = String(input);
				if (url.endsWith("/api/brain/internal/commands/publish")) {
					primaryBody = String(init?.body ?? "{}");
					return new Response("publish failed", {
						status: 502,
						statusText: "Bad Gateway",
						headers: { "Content-Type": "text/plain" },
					});
				}

				if (url.endsWith("/api/brain/internal/messages/queue")) {
					expect(init?.method).toBe("POST");
					expect(String(init?.body ?? "")).toBe(primaryBody);
					return new Response("queued", {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				throw new Error(`Unexpected endpoint: ${url}`);
			}) as typeof fetch,
		);

		const messageId = await sendToBrain({
			from: "arm-fallback-queue",
			to: "brain",
			type: "status_report",
			payload: { status: "ok" },
		});

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(primaryBody).toContain(`"${messageId}"`);
		expect(primaryBody).toContain('"arm-fallback-queue"');
		expect(primaryBody).toContain('"status_report"');
	});

	it("falls back to local queue file when both publish and queue APIs fail", async () => {
		process.env.COLEO_MCP_COMMAND_PUBLISH_MODE = "api";

		const messageType = "status_update" as const;
		const fallbackFrom = "arm-file-fallback";

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (input: Parameters<typeof fetch>[0]) => {
				const url = String(input);
				if (url.endsWith("/api/brain/internal/commands/publish")) {
					throw new Error("command api down");
				}
				if (url.endsWith("/api/brain/internal/messages/queue")) {
					return new Response("queue unavailable", {
						status: 503,
						statusText: "Service Unavailable",
						headers: { "Content-Type": "text/plain" },
					});
				}
				throw new Error(`Unexpected endpoint: ${url}`);
			}) as typeof fetch,
		);

		const messageId = await sendToBrain({
			from: fallbackFrom,
			to: "brain",
			type: messageType,
			payload: { status: "degraded" },
		});

		const queueFile = join(
			COLEO_DIR,
			"queue",
			"brain",
			"pending",
			`${messageId}-${fallbackFrom}-${messageType}.json`,
		);
		await access(queueFile);
		const raw = await readFile(queueFile, "utf-8");
		const payload = JSON.parse(raw) as {
			id: string;
			from: string;
			to: string;
			type: string;
			payload: { status: string };
			timestamp: string;
		};

		expect(payload.id).toBe(messageId);
		expect(payload.from).toBe(fallbackFrom);
		expect(payload.to).toBe("brain");
		expect(payload.type).toBe(messageType);
		expect(payload.payload).toEqual({ status: "degraded" });
		expect(payload.timestamp).toBeDefined();

		await rm(queueFile, { recursive: false, force: true });
	});
});
