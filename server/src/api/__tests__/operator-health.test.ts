import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSystemRoutes } from "../routes/system";
import { createAuthMiddleware } from "../middleware/auth";
import { getArmClient, setArmClient } from "../arm-client-registry";

test("operator health is authenticated and exposes missing readiness instead of liveness defaults", async () => {
  // Other test files leak mocks into the process-wide arm-client registry in
  // unspecified order; this readiness inventory must not depend on them.
  const previous = getArmClient();
  setArmClient(null);
  const db = new Database(":memory:");
  db.exec("CREATE TABLE brain_state (id INTEGER, status TEXT, started_at TEXT, last_poll_at TEXT); CREATE TABLE infrastructure_health (component TEXT, healthy INTEGER, optional INTEGER, error TEXT, last_check TEXT)");
  const app = new Hono<{ Variables: { db: Database; startedAt: Date } }>();
  app.use("/api/*", createAuthMiddleware("operator-test-key"));
  app.use("*", async (c, next) => { c.set("db", db); c.set("startedAt", new Date()); await next(); });
  app.route("/api", createSystemRoutes());
  try {
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/operator/health")).status).toBe(401);
    const response = await app.request("/api/operator/health", { headers: { "X-API-Key": "operator-test-key" } });
    expect(response.status).toBe(200);
    const data = await response.json() as { ok: boolean; checks: Array<{ name: string; status: string }> };
    expect(data.ok).toBe(false);
    expect(data.checks.find(check => check.name === "brain_poll")?.status).toBe("unknown");
    expect(data.checks.find(check => check.name === "maildir")?.status).toBe("unknown");
    expect(data.checks.find(check => check.name === "arm_hosts")?.status).toBe("unknown");
    expect((await app.request("/api/operator/health?since=invalid", { headers: { "X-API-Key": "operator-test-key" } })).status).toBe(400);
  } finally { setArmClient(previous); db.close(); }
});
