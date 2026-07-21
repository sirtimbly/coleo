import { describe, expect, it } from "bun:test";

import { ArmClient } from "../arm-client";
import type { AgentCommand, CommandResponse } from "../types";

describe("ArmClient distributed prompts", () => {
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
