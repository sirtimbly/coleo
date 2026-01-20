/**
 * API Key authentication middleware
 */
import type { Context, Next } from "hono";

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

    // Check header first, then query param (for SSE endpoints that can't send headers)
    const providedKey = c.req.header("X-API-Key") || c.req.query("api_key");

    if (!providedKey) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing X-API-Key header",
        },
        401
      );
    }

    if (providedKey !== apiKey) {
      console.log(`[Auth] Mismatch! Expected: '${apiKey}', Got: '${providedKey}'`);
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
