import { describe, expect, it } from "bun:test";

import { createMcpServer } from "../server";

interface RegisteredTool {
  description?: string;
}

interface RegisteredResource {
  name?: string;
}

function inspectServer(): {
  tools: Record<string, RegisteredTool>;
  resources: Record<string, RegisteredResource>;
} {
  const server = createMcpServer() as unknown as Record<string, unknown>;
  return {
    tools: server._registeredTools as Record<string, RegisteredTool>,
    resources: server._registeredResources as Record<string, RegisteredResource>,
  };
}

describe("createMcpServer", () => {
  it("registers the core arm workflow tools that map to live brain features", () => {
    const server = inspectServer();

    expect(Object.keys(server.tools)).toEqual(
      expect.arrayContaining([
        "claim_task",
        "complete_task",
        "submit_status_report",
        "get_my_instructions",
        "get_task_determination",
        "get_context_bundle",
        "get_full_briefing",
        "report_discovery",
        "claim_bug",
        "prepare_task",
        "service_status",
        "search",
        "search_status_history",
      ]),
    );
  });

  it("documents async queue semantics for task mutation tools", () => {
    const server = inspectServer();

    expect(server.tools.claim_task?.description).toContain("asynchronous claim request");
    expect(server.tools.complete_task?.description).toContain("command queue");
    expect(server.tools.get_my_instructions?.description).toContain("assigned to this arm");
  });

  it("registers the shared resources used by arm prompts", () => {
    const server = inspectServer();

    expect(server.resources["coleo://tasks/pending"]?.name).toContain("tasks available to claim");
    expect(server.resources["coleo://notes/shared"]?.name).toContain("Shared knowledge");
    expect(server.resources["coleo://status"]?.name).toContain("Current system status");
  });
});
