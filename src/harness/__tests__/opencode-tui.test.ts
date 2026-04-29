import { afterEach, describe, expect, it } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";

import { OpenCodeTuiHarness } from "../opencode-tui";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_URL = process.env.COLEO_API_URL;

function createFetchMock(
  impl: (input: string | URL | Request) => Promise<Response>,
): typeof fetch {
  const mock = Object.assign(impl, { preconnect: () => {} });
  return mock as typeof fetch;
}

function createJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => body,
  } as Response;
}

function createClient(
  sessions: Array<{ id?: string; title?: string }>,
): OpencodeClient {
  return {
    session: {
      list: async () => ({ data: sessions }),
    },
  } as unknown as OpencodeClient;
}

function invokeDetermineSessionRecoveryStrategy(
  harness: OpenCodeTuiHarness,
  armId: string,
  client: OpencodeClient,
): Promise<{ shouldResume: boolean; existingSessionId?: string; reason: string }> {
  const privateApi = harness as unknown as {
    determineSessionRecoveryStrategy: (
      armId: string,
      client: OpencodeClient,
    ) => Promise<{ shouldResume: boolean; existingSessionId?: string; reason: string }>;
  };
  return privateApi.determineSessionRecoveryStrategy(armId, client);
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_URL === undefined) {
    delete process.env.COLEO_API_URL;
  } else {
    process.env.COLEO_API_URL = ORIGINAL_API_URL;
  }
});

describe("OpenCodeTuiHarness", () => {
  it("reports the live capabilities used by the brain", () => {
    const harness = new OpenCodeTuiHarness();

    expect(harness.name).toBe("opencode-tui");
    expect(harness.version).toBe("1.0.0");
    expect(harness.capabilities).toEqual({
      mcp: true,
      streaming: true,
      interrupt: true,
      compact: true,
      multiTurn: true,
      fileEditing: true,
      commandExecution: true,
    });
  });

  it("resumes an in-progress task when a matching Coleo session exists", async () => {
    process.env.COLEO_API_URL = "http://example.test";
    globalThis.fetch = createFetchMock(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/arms/arm-1")) {
        return createJsonResponse({ arm: { currentTaskId: "task-1" } });
      }
      if (url.endsWith("/api/tasks/task-1")) {
        return createJsonResponse({ task: { status: "in_progress", assignedTo: "arm-1" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await invokeDetermineSessionRecoveryStrategy(
      new OpenCodeTuiHarness(),
      "arm-1",
      createClient([
        { id: "session-1", title: "Coleo Arm: arm-1 (2026-04-20T00:00:00.000Z)" },
        { id: "manual-1", title: "Scratchpad" },
      ]),
    );

    expect(result).toEqual({
      shouldResume: true,
      existingSessionId: "session-1",
      reason: "Task task-1 is in_progress and assigned to this arm",
    });
  });

  it("starts fresh when the assigned task is no longer in progress", async () => {
    process.env.COLEO_API_URL = "http://example.test";
    globalThis.fetch = createFetchMock(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/arms/arm-1")) {
        return createJsonResponse({ arm: { currentTaskId: "task-1" } });
      }
      if (url.endsWith("/api/tasks/task-1")) {
        return createJsonResponse({ task: { status: "completed", assignedTo: "arm-1" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await invokeDetermineSessionRecoveryStrategy(
      new OpenCodeTuiHarness(),
      "arm-1",
      createClient([{ id: "session-1", title: "Coleo Arm: arm-1 (2026-04-20T00:00:00.000Z)" }]),
    );

    expect(result.shouldResume).toBe(false);
    expect(result.reason).toContain('Task status is "completed"');
  });

  it("starts fresh when there is no matching Coleo session to recover", async () => {
    process.env.COLEO_API_URL = "http://example.test";
    globalThis.fetch = createFetchMock(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/arms/arm-1")) {
        return createJsonResponse({ arm: { currentTaskId: "task-1" } });
      }
      if (url.endsWith("/api/tasks/task-1")) {
        return createJsonResponse({ task: { status: "in_progress", assignedTo: "arm-1" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await invokeDetermineSessionRecoveryStrategy(
      new OpenCodeTuiHarness(),
      "arm-1",
      createClient([{ id: "session-1", title: "Coleo Arm: arm-2 (2026-04-20T00:00:00.000Z)" }]),
    );

    expect(result).toEqual({
      shouldResume: false,
      reason: "Task is in_progress but no existing session found",
    });
  });
});
