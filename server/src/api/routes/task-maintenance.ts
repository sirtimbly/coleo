import { Hono } from "hono";
import { HttpError } from "../middleware";
import { getServerWorkspaceAccess } from "../workspace-access";
import { maintainTasks } from "../services/task-maintenance";
import type { Database } from "bun:sqlite";

export function createTaskMaintenanceRoutes(): Hono<{ Variables: { db: Database } }> {
  const app = new Hono<{ Variables: { db: Database } }>();
  for (const operation of ["sync", "reparse", "unclaim"] as const) {
    app.post(`/${operation}`, async (c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch { throw HttpError.badRequest("Expected an empty JSON object"); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
        throw HttpError.badRequest("Expected an empty JSON object; maintenance uses the server workspace");
      }
      return c.json(await maintainTasks(c.get("db"), operation,
        operation === "unclaim" ? undefined : getServerWorkspaceAccess()));
    });
  }
  return app;
}
