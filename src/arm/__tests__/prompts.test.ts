import { describe, it, expect } from "bun:test";
import { generateSystemPrompt, generateDomainSpecificInstructions } from "../prompts";

describe("arm prompts", () => {
  it("generates system prompt with key fields", () => {
    const prompt = generateSystemPrompt({
      armId: "arm-1",
      domain: "general",
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

  it("returns empty domain-specific instructions while disabled", () => {
    expect(generateDomainSpecificInstructions("frontend")).toBe("");
  });
});
