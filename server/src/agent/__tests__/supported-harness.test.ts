import { describe, expect, it } from "bun:test";
import { ArmAgent } from "../arm-agent";
import { harnessRegistry } from "../../harness/registry";
import type { AgentCommand, CommandResponse } from "../../nats/types";

describe("supported arm harnesses", () => {
  it("advertises only the tested API harness", () => {
    expect(harnessRegistry.list()).toEqual(["opencode-api"]);
    expect(harnessRegistry.get("opencode-api").getMessages).toBeFunction();
  });

  for (const harness of ["opencode", "opencode-tui", "custom"]) {
    it(`rejects direct agent spawn commands for ${harness}`, async () => {
      const agent = new ArmAgent({ agentId: "test-host", natsUrl: "nats://localhost:4222", coleoDir: "/tmp" });
      const internals = agent as unknown as {
        handleCommand(command: AgentCommand): Promise<CommandResponse>;
        managedArms: Map<string, unknown>;
      };
      const response = await internals.handleCommand({
        type: "spawn", requestId: "unsupported", armId: "legacy", name: "Legacy", domain: "general", harness,
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain("opencode-api");
      expect(internals.managedArms.size).toBe(0);
    });
  }
});
