import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { createAgentsRoutes } from "../routes/agents";
import { setArmClient } from "../arm-client-registry";
import type { ArmClient } from "../../nats/arm-client";

describe("agent provider status API", () => {
  afterEach(() => {
    setArmClient(null);
  });

  it("returns only configured providers for every connected arm host", async () => {
    const queriedAgents: string[] = [];
    setArmClient({
      getAgents: () => [
        {
          agentId: "reef-1",
          hostname: "reef-one",
          version: "0.2.0",
          capabilities: ["opencode-api", "opencode-provider-auth"],
        },
        {
          agentId: "reef-old",
          hostname: "reef-old",
          version: "0.1.0",
          capabilities: ["opencode-api"],
        },
      ],
      getOpenCodeProviders: async (agentId: string) => {
        queriedAgents.push(agentId);
        return {
          requestId: "providers-1",
          success: true,
          data: {
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                models: [],
                connected: true,
                authMethod: "api-key" as const,
              },
              {
                id: "github-copilot",
                name: "GitHub Copilot",
                models: [],
                connected: false,
                authMethod: "oauth" as const,
              },
            ],
          },
        };
      },
    } as unknown as ArmClient);

    const app = new Hono();
    app.route("/api/agents", createAgentsRoutes());
    const response = await app.request("http://coleo.test/api/agents/providers");

    expect(response.status).toBe(200);
    expect(queriedAgents).toEqual(["reef-1"]);
    expect(await response.json()).toEqual({
      hosts: [
        {
          agentId: "reef-1",
          hostname: "reef-one",
          version: "0.2.0",
          configuredProviders: [{ id: "openai", name: "OpenAI", authMethod: "api-key" }],
          availableProviderCount: 2,
          error: null,
        },
        {
          agentId: "reef-old",
          hostname: "reef-old",
          version: "0.1.0",
          configuredProviders: [],
          availableProviderCount: 0,
          error: "Update this arm host to detect configured providers",
        },
      ],
    });
  });
});
