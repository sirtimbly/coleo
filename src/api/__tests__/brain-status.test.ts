import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import {
  detectBrainModelAccessIssue,
  serializeBrainModelAccessIssue,
} from "../../brain/model-access";
import { createBrainRoutes } from "../routes/brain";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE brain_state (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      poll_interval_ms INTEGER NOT NULL,
      started_at TEXT,
      last_poll_at TEXT,
      pending_tasks INTEGER NOT NULL DEFAULT 0,
      completed_today INTEGER NOT NULL DEFAULT 0,
      completed_task_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO brain_state (id, status, poll_interval_ms, updated_at)
    VALUES (1, 'running', 30000, datetime('now'));

    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      planning_blocked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      source_type TEXT,
      blocked_category TEXT,
      blocked_reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE infrastructure_health (
      component TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL,
      optional INTEGER NOT NULL,
      error TEXT,
      last_check TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("brain status API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;
  let startCalls = 0;
  let startSucceeds = true;
  let stopCalls = 0;
  let stopSucceeds = true;
  let stopError: Error | null = null;
  let startWait: Promise<void> | undefined;
  let stopWait: Promise<void> | undefined;

  beforeEach(() => {
    db = createTestDb();
    startCalls = 0;
    startSucceeds = true;
    stopCalls = 0;
    stopSucceeds = true;
    stopError = null;
    startWait = undefined;
    stopWait = undefined;
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/brain", createBrainRoutes({ startBrain: async () => {
      startCalls += 1;
      await startWait;
      return { type: "brain", running: startSucceeds, pid: 1234, startedAt: "2026-09-18T19:00:00.000Z" };
    }, stopBrain: async () => {
      stopCalls += 1;
      await stopWait;
      if (stopError) throw stopError;
      return { type: "brain", running: !stopSucceeds, pid: 1234 };
    } }));
  });

  afterEach(() => {
    db.close();
  });

  it("starts the process even when stored status already says running without inventing a poll", async () => {
    const response = await app.request("/api/brain/start", { method: "POST" });
    expect(response.status).toBe(200);
    expect(startCalls).toBe(1);
    expect(await response.json()).toEqual({ started: true, status: "running", pid: 1234 });
    expect(db.query("SELECT last_poll_at FROM brain_state").get()).toEqual({ last_poll_at: null });
  });

  it("does not report a successful start when the process fails to launch", async () => {
    startSucceeds = false;
    db.run("UPDATE brain_state SET status = 'stopped'");
    app.onError((error, c) => c.json({ error: error.message }, 503));
    const response = await app.request("/api/brain/start", { method: "POST" });
    expect(response.status).toBe(503);
    expect(db.query("SELECT status, last_poll_at FROM brain_state").get()).toEqual({ status: "stopped", last_poll_at: null });
  });

  it("waits for the managed process to stop before updating state", async () => {
    let release!: () => void;
    stopWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = app.request("/api/brain/stop", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopCalls).toBe(1);
    expect(db.query("SELECT status FROM brain_state").get()).toEqual({ status: "running" });
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true, status: "stopped" });
    expect(db.query("SELECT status, last_poll_at FROM brain_state").get()).toEqual({ status: "stopped", last_poll_at: null });
  });

  it("checks the process even when persisted status already says stopped", async () => {
    db.run("UPDATE brain_state SET status = 'stopped'");
    expect((await app.request("/api/brain/stop", { method: "POST" })).status).toBe(200);
    expect(stopCalls).toBe(1);
  });

  it.each(["timeout", "exception"])("does not report stopped after a service %s", async (failure) => {
    stopSucceeds = false;
    if (failure === "exception") stopError = new Error("Unable to signal process");
    app.onError((error, c) => c.json({ error: error.message }, 503));
    const response = await app.request("/api/brain/stop", { method: "POST" });
    expect(response.status).toBe(503);
    expect(db.query("SELECT status, last_poll_at FROM brain_state").get()).toEqual({ status: "running", last_poll_at: null });
    stopError = null;
    stopSucceeds = true;
    expect((await app.request("/api/brain/stop", { method: "POST" })).status).toBe(200);
  });

  it("finishes an in-flight start before processing stop", async () => {
    let release!: () => void;
    startWait = new Promise<void>((resolve) => { release = resolve; });
    const start = app.request("/api/brain/start", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stop = app.request("/api/brain/stop", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startCalls).toBe(1);
    expect(stopCalls).toBe(0);
    release();
    expect((await start).status).toBe(200);
    expect((await stop).status).toBe(200);
    expect(stopCalls).toBe(1);
    expect(db.query("SELECT status FROM brain_state").get()).toEqual({ status: "stopped" });
  });

  it("reports blocked, healthy, and pending project plan states", async () => {
    let response = await app.request("/api/brain/status");
    let body = await response.json() as { brain: { plan: { status: string; detail: string } } };
    expect(body.brain.plan.status).toBe("pending");

    db.run(
      "INSERT INTO tasks (id, status, source_type, updated_at) VALUES (?, ?, ?, ?)",
      ["plan-task", "pending", "plan", new Date().toISOString()],
    );
    response = await app.request("/api/brain/status");
    body = await response.json() as { brain: { plan: { status: string; detail: string } } };
    expect(body.brain.plan.status).toBe("healthy");
    expect(body.brain.plan.detail).toContain("1 plan task is synchronized");

    db.run(
      `UPDATE tasks SET status = 'blocked', blocked_category = 'planning', blocked_reason = ?, updated_at = ? WHERE id = ?`,
      [
        "Project planning must succeed before work can resume: Plan formatter returned 500: overloaded [planning-state:abc]",
        new Date().toISOString(),
        "plan-task",
      ],
    );
    response = await app.request("/api/brain/status");
    body = await response.json() as { brain: { plan: { status: string; detail: string } } };
    expect(body.brain.plan.status).toBe("blocked");
    expect(body.brain.plan.detail).toBe("Plan formatter returned 500: overloaded");
  });

  it("reports insufficient credits without changing runtime status", async () => {
    const issue = detectBrainModelAccessIssue(
      429,
      '{"error":{"message":"You have no credits remaining. Add credits to continue."}}',
      "openai",
    );
    expect(issue).not.toBeNull();
    if (!issue) return;

    db.run(
      `INSERT INTO infrastructure_health
        (component, healthy, optional, error, last_check, updated_at)
       VALUES (?, 0, 0, ?, ?, ?)`,
      [
        "brain_model_api",
        serializeBrainModelAccessIssue(issue),
        "2026-08-04T12:27:26.000Z",
        "2026-08-04T12:27:26.000Z",
      ],
    );

    const response = await app.request("/api/brain/status");
    const body = await response.json() as {
      brain: {
        status: string;
        modelAccess: {
          status: string;
          issueCode: string;
          actionUrl: string;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.brain.status).toBe("running");
    expect(body.brain.modelAccess).toMatchObject({
      status: "blocked",
      issueCode: "insufficient_credits",
    });
    expect(body.brain.modelAccess.actionUrl).toContain("platform.openai.com");

    const recovered = await app.request("/api/brain/internal/infrastructure-health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        components: [
          {
            component: "brain_model_api",
            healthy: true,
            optional: false,
          },
        ],
      }),
    });
    expect(recovered.status).toBe(200);

    const recoveredStatus = await app.request("/api/brain/status");
    const recoveredBody = await recoveredStatus.json() as {
      brain: { status: string; modelAccess: { status: string; issueCode: string | null } };
    };
    expect(recoveredBody.brain.modelAccess).toMatchObject({
      status: "available",
      issueCode: null,
    });
  });

	it("reports the durable planning gate even when no task carries the blocker", async () => {
		db.run(
			`INSERT INTO infrastructure_health
			  (component, healthy, optional, error, last_check, updated_at)
			 VALUES (?, 0, 0, ?, ?, ?)`,
			[
				"brain_planning_gate",
				JSON.stringify({
					detail: "The plan is missing deployment architecture",
					nextStep: "Add deployment decisions to .project/plan.md.",
				}),
				"2026-08-13T12:00:00.000Z",
				"2026-08-13T12:00:00.000Z",
			],
		);

		const response = await app.request("/api/brain/status");
		const body = await response.json() as {
			brain: { plan: { status: string; detail: string; nextStep: string | null } };
		};

		expect(body.brain.plan).toMatchObject({
			status: "blocked",
			detail: "The plan is missing deployment architecture",
			nextStep: "Add deployment decisions to .project/plan.md.",
		});
	});
});
