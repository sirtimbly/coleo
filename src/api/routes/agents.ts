/**
 * Agent Routes - API for distributed arm agent management
 */
import { Hono } from "hono";
import type { ServerContext } from "../server-context";
import { getArmClient } from "../arm-client-registry";
import { HttpError } from "../middleware";

export function createAgentsRoutes(): Hono<ServerContext> {
  const app = new Hono<ServerContext>();

  /**
   * GET /api/agents - List all connected agents
   */
  app.get("/", (c) => {
    const armClient = getArmClient();

    if (!armClient) {
      throw new HttpError(503, "NATS/ArmClient not available");
    }

    const agents = armClient.getAgents().map((agent) => ({
      agentId: agent.agentId,
      hostname: agent.hostname,
      platform: agent.platform,
      startedAt: agent.startedAt,
      version: agent.version,
      capabilities: agent.capabilities,
      maxArms: agent.maxArms,
    }));

    return c.json({ agents });
  });

  /**
   * GET /api/agents/:id - Get a specific agent
   */
  app.get("/:id", (c) => {
    const armClient = getArmClient();
    const agentId = c.req.param("id");

    if (!armClient) {
      throw new HttpError(503, "NATS/ArmClient not available");
    }

    const agent = armClient.getAgent(agentId);
    if (!agent) {
      throw HttpError.notFound("Agent not found");
    }

    return c.json({ agent });
  });

  /**
   * GET /api/agents/:id/arms - List arms on a specific agent
   */
  app.get("/:id/arms", async (c) => {
    const armClient = getArmClient();
    const agentId = c.req.param("id");

    if (!armClient) {
      return c.json({ error: "NATS/ArmClient not available" }, 503);
    }

    const agent = armClient.getAgent(agentId);
    if (!agent) {
      return c.json({ error: "Agent not found" }, 404);
    }

    try {
      const response = await armClient.listArmsOnAgent(agentId);
      if (!response.success) {
        return c.json({ error: response.error || "Failed to list arms" }, 500);
      }
      return c.json({ arms: response.data?.arms || [] });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}
