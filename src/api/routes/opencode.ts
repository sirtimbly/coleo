/**
 * OpenCode Integration Routes
 *
 * Provides endpoints to interact with OpenCode server for:
 * - Fetching available providers and models
 * - Provider status
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";

interface OpenCodeContext {
  Variables: {
    db: Database;
  };
}

// OpenCode server default port
const OPENCODE_DEFAULT_PORT = 4096;
const OPENCODE_DEFAULT_HOST = "127.0.0.1";

interface OpenCodeModel {
  id: string;
  name: string;
  limit?: {
    context?: number;
    output?: number;
  };
}

interface OpenCodeProvider {
  id: string;
  name: string;
  models: OpenCodeModel[];
}

/**
 * Try to find a running OpenCode server
 * OpenCode typically runs on port 4096, but may use other ports
 */
async function findOpenCodeServer(): Promise<string | null> {
  const ports = [OPENCODE_DEFAULT_PORT, 4097, 4098, 4099];

  for (const port of ports) {
    try {
      const url = `http://${OPENCODE_DEFAULT_HOST}:${port}/global/health`;
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) {
        return `http://${OPENCODE_DEFAULT_HOST}:${port}`;
      }
    } catch {
      // Try next port
    }
  }

  return null;
}

export function createOpenCodeRoutes() {
  const app = new Hono<OpenCodeContext>();

  /**
   * Get available providers and models from OpenCode server
   * GET /api/opencode/providers
   */
  app.get("/providers", async (c) => {
    try {
      const serverUrl = await findOpenCodeServer();

      if (!serverUrl) {
        // Return fallback providers when no OpenCode server is running
        return c.json({
          providers: [
            {
              id: "github-copilot",
              name: "GitHub Copilot",
              models: [
                { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
              ],
            },
            {
              id: "opencode",
              name: "OpenCode Zen",
              models: [
                { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
                { id: "claude-opus-4", name: "Claude Opus 4" },

              ],
            },
          ] as OpenCodeProvider[],
          connected: [],
          fallback: true,
          message: "OpenCode server not running - showing default providers",
        });
      }

      // Fetch providers from OpenCode server
      const response = await fetch(`${serverUrl}/provider`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`OpenCode server returned ${response.status}`);
      }

      const data = await response.json() as {
        all: Array<{
          id: string;
          name: string;
          models?: Record<string, { name?: string; limit?: { context?: number; output?: number } }>;
        }>;
        connected: string[];
        default: Record<string, string>;
      };

      // Transform the response to our format
      // Filter to only show GitHub Copilot and OpenCode Zen for now
      const relevantProviderIds = ["github-copilot", "opencode"];

      const providers: OpenCodeProvider[] = data.all
        .filter(p => relevantProviderIds.includes(p.id))
        .map(p => ({
          id: p.id,
          name: p.name,
          models: p.models
            ? Object.entries(p.models).map(([id, info]) => ({
                id,
                name: info.name || id,
                limit: info.limit,
              }))
            : [],
        }));

      return c.json({
        providers,
        connected: data.connected.filter(id => relevantProviderIds.includes(id)),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Don't throw error, return fallback
      return c.json({
        providers: [
          {
            id: "github-copilot",
            name: "GitHub Copilot",
            models: [
              { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
              { id: "gpt-4o", name: "GPT-4o" },
            ],
          },
          {
            id: "opencode",
            name: "OpenCode Zen",
            models: [
              { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
            ],
          },
        ] as OpenCodeProvider[],
        connected: [],
        error: message,
        fallback: true,
      });
    }
  });

  /**
   * Check if OpenCode server is running
   * GET /api/opencode/health
   */
  app.get("/health", async (c) => {
    try {
      const serverUrl = await findOpenCodeServer();

      if (!serverUrl) {
        return c.json({
          running: false,
          message: "OpenCode server not found",
        });
      }

      const response = await fetch(`${serverUrl}/global/health`, {
        signal: AbortSignal.timeout(2000),
      });

      const data = await response.json() as { healthy: boolean; version: string };

      return c.json({
        running: true,
        healthy: data.healthy,
        version: data.version,
        url: serverUrl,
      });
    } catch (err) {
      return c.json({
        running: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return app;
}
