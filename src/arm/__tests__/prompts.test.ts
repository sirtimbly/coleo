import { describe, it, expect } from "bun:test";
import { generateSystemPrompt } from "../prompts";

describe("arm prompts", () => {
  it("generates system prompt with key fields", () => {
    const prompt = generateSystemPrompt({
      armId: "arm-1",
      name: "ArmOne",
      workdir: "/tmp",
      harness: "opencode",
      provider: "opencode",
      model: "gpt-5-mini",
    });

    expect(prompt).toContain("ArmOne");
    expect(prompt).toContain("arm-1");
    expect(prompt).toContain("/tmp");
    expect(prompt).toContain("get_full_briefing");
  });
});
