/**
 * Request logging middleware
 */
import type { Context, Next } from "hono";

export async function logger(c: Context, next: Next): Promise<void | Response> {
  const logLevel = process.env.OCTOPAI_LOG_LEVEL || "quiet";
  const verbose = logLevel === "verbose";
  
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  if (verbose) {
    console.log(`--> ${method} ${path}`);
  }

  await next();

  if (verbose) {
    const duration = Date.now() - start;
    const status = c.res.status;
    const statusEmoji = status >= 400 ? "x" : status >= 300 ? "~" : "o";
    console.log(`<-- ${method} ${path} ${status} ${statusEmoji} ${duration}ms`);
  }
}
