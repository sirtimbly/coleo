import { expect, it, spyOn } from "bun:test";
import { ArmAgent } from "../arm-agent";
import { OpenCodeApiHarness } from "../../harness/opencode-api";
import { ModelCheckError } from "../../harness/model-check-error";
import * as preflight from "../../harness/model-preflight";
import type { AgentCommand, CommandResponse } from "../../nats/types";

it("rejects an unavailable model before starting or registering an Arm", async () => {
  const check = spyOn(preflight, "verifySpawnModel").mockRejectedValue(new ModelCheckError("openai", "unavailable-model", "unsupported model"));
  const spawn = spyOn(OpenCodeApiHarness.prototype, "spawn");
  try {
    const agent = new ArmAgent({ agentId: "host", natsUrl: "nats://localhost:4222", coleoDir: "/tmp" });
    const internals = agent as unknown as {
      handleCommand(command: AgentCommand): Promise<CommandResponse>;
      managedArms: Map<string, unknown>;
    };
    const response = await internals.handleCommand({
      type: "spawn", requestId: "check", armId: "new-arm", name: "New Arm", domain: "general",
      harness: "opencode-api", provider: "openai", model: "unavailable-model",
    });
    expect(response.success).toBe(false);
    expect(response.errorCode).toBe("MODEL_CHECK_FAILED");
    expect(response.error).toContain("unsupported model");
    expect(check).toHaveBeenCalledWith("opencode-api", "openai", "unavailable-model");
    expect(spawn).not.toHaveBeenCalled();
    expect(internals.managedArms.size).toBe(0);
    // A failed validation releases the reservation so changing the model can retry.
    await internals.handleCommand({
      type: "spawn", requestId: "retry", armId: "new-arm", name: "New Arm", domain: "general",
      harness: "opencode-api", provider: "openai", model: "another-model",
    });
    expect(check).toHaveBeenCalledTimes(2);
  } finally {
    check.mockRestore();
    spawn.mockRestore();
  }
});

it("reserves the Arm name while a model check is pending", async () => {
  let rejectCheck!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectCheck = reject; });
  const check = spyOn(preflight, "verifySpawnModel").mockReturnValue(pending);
  try {
    const agent = new ArmAgent({ agentId: "host", natsUrl: "nats://localhost:4222", coleoDir: "/tmp" });
    const internals = agent as unknown as { handleCommand(command: AgentCommand): Promise<CommandResponse> };
    const command = { type: "spawn", requestId: "one", armId: "new-arm", name: "New Arm", domain: "general", harness: "opencode-api", provider: "openai", model: "model" } as const;
    const first = internals.handleCommand(command);
    const duplicate = await internals.handleCommand({ ...command, requestId: "two" });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toContain("already being checked");
    rejectCheck(new Error("Provider unavailable"));
    await first;
    expect(check).toHaveBeenCalledTimes(1);
  } finally {
    check.mockRestore();
  }
});
