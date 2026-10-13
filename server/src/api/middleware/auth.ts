/**
 * API Key authentication middleware
 */
import type { Context, Next } from "hono";

export const REEF_PROXY_API_KEY_HEADER = "X-Coleo-API-Key";

export function apiKeyMatches(providedKey: string | null | undefined, apiKey: string): boolean {
  return typeof providedKey === "string" && providedKey.length > 0 && providedKey === apiKey;
}

/**
 * Create auth middleware with the given API key
 */
export function createAuthMiddleware(apiKey: string) {
  return async function auth(c: Context, next: Next): Promise<void | Response> {
    // Skip auth for health endpoint
    if (c.req.path === "/api/health") {
      return next();
    }

    // Skip auth for dev mode (keys starting with "dev-")
    if (apiKey.startsWith("dev-")) {
      return next();
    }

    // Reef authenticates the user with WorkOS, then supplies its private
    // service-to-service credential. Direct/self-hosted clients continue to use
    // X-API-Key, while query auth remains available for direct SSE clients.
    const providedKey =
      c.req.header(REEF_PROXY_API_KEY_HEADER) ||
      c.req.header("X-API-Key") ||
      c.req.query("api_key");

    if (!providedKey) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing X-API-Key header",
        },
        401
      );
    }

    if (!apiKeyMatches(providedKey, apiKey)) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Invalid API key",
        },
        401
      );
    }

    await next();
  };
}
