import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createArmsRoutes } from "../routes/arms";
import { formatErrorResponse } from "../middleware/error";
import { getArmClient, setArmClient } from "../arm-client-registry";
import type { ArmClient } from "../../nats/arm-client";

let db: Database;
let app: Hono<{ Variables: { db: Database } }>;
let previous: ArmClient | null;
beforeEach(() => {
  previous = getArmClient();
  setArmClient(null);
  db = new Database(":memory:");
  db.exec(`CREATE TABLE arms (id TEXT PRIMARY KEY, status TEXT, agent_id TEXT, pid INTEGER,
    port INTEGER, session_id TEXT, host TEXT, planning_blocked INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE claims (id TEXT PRIMARY KEY, arm_id TEXT, released_at TEXT);`);
  app = new Hono();
  app.use("*", async (c, next) => { c.set("db", db); await next(); });
  app.route("/api/arms", createArmsRoutes());
  app.onError((error, c) => formatErrorResponse(c, error));
});
afterEach(() => { setArmClient(previous); db.close(); });

function arm(id: string, host: string | null = null): void {
  db.run("INSERT INTO arms (id, status, agent_id, pid, session_id) VALUES (?, 'busy', ?, ?, ?)",
    [id, host, host ? 1234 : null, host ? "session" : null]);
  db.run("INSERT INTO claims VALUES (?, ?, NULL)", [`claim-${id}`, id]);
}

test("individual stop routes to saved host, preserves profile, and releases claims", async () => {
  arm("remote", "saved-host");
  const calls: unknown[] = [];
  setArmClient({ killArm: async (...args: unknown[]) => {
    calls.push(args);
    return { success: true };
  } } as unknown as ArmClient);
  const response = await app.request("/api/arms/remote/kill", { method: "POST" });
  expect(response.status).toBe(200);
  expect(calls).toEqual([["remote", 30_000, "saved-host"]]);
  expect(await response.json()).toMatchObject({ killed: true, releasedClaims: 1 });
  expect(db.query("SELECT status, pid, session_id, agent_id FROM arms WHERE id='remote'").get())
    .toEqual({ status: "stopped", pid: null, session_id: null, agent_id: null });
  expect(db.query("SELECT released_at FROM claims").get()).toMatchObject({ released_at: expect.any(String) });
});

test("remote stop failure retains runtime and claims instead of falling through to local kill", async () => {
  arm("remote", "offline");
  setArmClient({ killArm: async () => ({ success: false, error: "Host unavailable" }) } as unknown as ArmClient);
  const response = await app.request("/api/arms/remote/kill", { method: "POST" });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("Host unavailable") });
  expect(db.query("SELECT status, agent_id FROM arms").get()).toEqual({ status: "busy", agent_id: "offline" });
  expect(db.query("SELECT released_at FROM claims").get()).toEqual({ released_at: null });
});

test("stop-all attempts hosts concurrently, retains all profiles, and reports partial failures", async () => {
  arm("one", "host"); arm("two", "host"); arm("offline", "offline"); arm("inactive");
  let started = 0;
  let release: () => void = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  setArmClient({ killArm: async (id: string) => {
    started++;
    if (started === 3) release();
    await ready;
    return { success: id !== "offline", error: id === "offline" ? "unreachable" : undefined };
  } } as unknown as ArmClient);
  const response = await app.request("/api/arms/stop-all", { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ stopped: 3, releasedClaims: 3,
    failed: [{ id: "offline", error: expect.stringContaining("unreachable") }] });
  expect(db.query("SELECT COUNT(*) AS count FROM arms").get()).toEqual({ count: 4 });
  expect(db.query("SELECT arm_id FROM claims WHERE released_at IS NULL").all()).toEqual([{ arm_id: "offline" }]);
});

test("stop is idempotent for stopped profiles and clears stale claims", async () => {
  arm("inactive");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request("/api/arms/inactive/kill", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ releasedClaims: attempt === 0 ? 1 : 0 });
  }
});

test("missing host connection does not claim that remote arms stopped", async () => {
  arm("remote", "host");
  expect((await app.request("/api/arms/remote/kill", { method: "POST" })).status).toBe(503);
  expect(db.query("SELECT released_at FROM claims").get()).toEqual({ released_at: null });
});
