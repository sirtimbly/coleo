import { describe, expect, it } from "bun:test";

import { ArmClient } from "../arm-client";
import type { AgentCommand, CommandResponse } from "../types";

describe("ArmClient distributed prompts", () => {
  it("can stop an arm using persisted ownership before discovery has caught up", async () => {
    const client = new ArmClient({ natsUrl: "nats://127.0.0.1:4222" });
    const calls: Array<{ agentId: string; command: AgentCommand }> = [];
    const internals = client as unknown as {
      natsClient: { sendCommand: (agentId: string, command: AgentCommand) => Promise<CommandResponse> };
    };
    internals.natsClient = { sendCommand: async (agentId, command) => {
      calls.push({ agentId, command });
      return { requestId: command.requestId, success: true };
    } };
    expect((await client.killArm("arm-1", 30_000, "saved-host")).success).toBe(true);
    expect(calls).toMatchObject([{ agentId: "saved-host", command: { type: "kill", armId: "arm-1" } }]);
  });

  it("includes interrupt in the prompt command", async () => {
    const client = new ArmClient({ natsUrl: "nats://127.0.0.1:4222" });
    let sentCommand: AgentCommand | undefined;
    const internals = client as unknown as {
      armToAgent: Map<string, string>;
      natsClient: {
        sendCommand: (
          agentId: string,
          command: AgentCommand,
          timeoutMs: number,
        ) => Promise<CommandResponse>;
      };
    };
    internals.armToAgent.set("arm-1", "agent-1");
    internals.natsClient = {
      sendCommand: async (_agentId, command) => {
        sentCommand = command;
        return { requestId: command.requestId, success: true };
      },
    };

    const response = await client.sendPrompt(
      "arm-1",
      "Replacement prompt",
      undefined,
      true,
    );

    expect(response.success).toBe(true);
    expect(sentCommand).toMatchObject({
      type: "prompt",
      armId: "arm-1",
      prompt: "Replacement prompt",
      interrupt: true,
    });
  });
});
