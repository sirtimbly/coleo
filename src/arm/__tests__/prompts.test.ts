import { describe, expect, it } from "bun:test";

import { generateSystemPrompt } from "../prompts";

describe("generateSystemPrompt", () => {
  it("includes the live task and mailbox workflow instructions", () => {
    const prompt = generateSystemPrompt({
      armId: "arm-1",
      name: "ArmOne",
      workdir: "/tmp/project",
      harness: "opencode",
      provider: "opencode",
      model: "gpt-5-mini",
    });

    expect(prompt).toContain("ID: arm-1");
    expect(prompt).toContain("Name: ArmOne");
    expect(prompt).toContain("Working Directory: /tmp/project");
    expect(prompt).toContain("Call the 'get_full_briefing' MCP tool");
    expect(prompt).toContain("Call 'claim_task' with the task ID");
    expect(prompt).toContain("Do not block waiting for an immediate response");
    expect(prompt).toContain("Check your mailbox with 'get_my_instructions'");
  });

  it("does not leak optional values as undefined text", () => {
    const prompt = generateSystemPrompt({
      armId: "arm-2",
      name: "ArmTwo",
      workdir: "/workspace",
      harness: "opencode-api",
    });

    expect(prompt).not.toContain("undefined");
    expect(prompt).toContain("Harness: opencode-api");
  });
});
