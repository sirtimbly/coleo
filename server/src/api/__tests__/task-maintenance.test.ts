import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { initDatabase } from "../../db";
import { LocalWorkspaceAccess } from "../../workspace";
import { maintainTasks } from "../services/task-maintenance";
import { createTaskMaintenanceRoutes } from "../routes/task-maintenance";
import { formatErrorResponse } from "../middleware/error";
import type { Database } from "bun:sqlite";

let root: string;
let db: Database;
let workspace: LocalWorkspaceAccess;
const plan = "## Phase 1: Test\n### Tasks\n- [ ] First task <!--octopai:abc12345-->\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coleo-maintenance-"));
  await mkdir(join(root, ".project"));
  await writeFile(join(root, ".project", "plan.md"), plan);
  db = await initDatabase(join(root, "test.db"));
  workspace = new LocalWorkspaceAccess(root);
});
afterEach(async () => { db?.close(); await rm(root, { recursive: true, force: true }); });

it("sync imports linked plans, skips hashes, and completes pending tasks without resetting active work", async () => {
  await writeFile(join(root, ".project", "other.md"), "### Tasks\n- [ ] Other task\n");
  await writeFile(join(root, ".project", "plan.md"), plan + "\n[Other](other.md)\n");
  expect((await maintainTasks(db, "sync", workspace)).added).toBe(2);
  expect((await maintainTasks(db, "sync", workspace)).skipped).toBe(2);
  db.run("UPDATE tasks SET status = 'in_progress' WHERE subject = 'Other task'");
  await writeFile(join(root, ".project", "other.md"), "### Tasks\n- [x] Other task\n");
  await writeFile(join(root, ".project", "plan.md"), plan.replace("[ ]", "[x]") + "\n[Other](other.md)\n");
  expect((await maintainTasks(db, "sync", workspace)).updated).toBe(1);
  expect(db.query("SELECT status FROM tasks WHERE subject = 'Other task'").get()).toEqual({ status: "in_progress" });
  expect(db.query("SELECT status, plan_line_uid FROM tasks WHERE subject = 'First task'").get())
    .toEqual({ status: "completed", plan_line_uid: "abc12345" });
});

it("reparse replaces plan tasks, preserves manual tasks, and leaves records intact when the plan is missing", async () => {
  await maintainTasks(db, "sync", workspace);
  db.run("INSERT INTO tasks (id, subject, description, source_type) VALUES ('manual', 'Manual', '', 'manual')");
  await rm(join(root, ".project", "plan.md"));
  expect((await maintainTasks(db, "reparse", workspace)).errors).toHaveLength(1);
  expect(db.query("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 2 });
  await writeFile(join(root, ".project", "plan.md"), plan.replace("First task", "Replacement"));
  const result = await maintainTasks(db, "reparse", workspace);
  expect(result.deleted).toBe(1);
  expect(result.added).toBe(1);
  expect(db.query("SELECT subject FROM tasks ORDER BY subject").all()).toEqual([{ subject: "Manual" }, { subject: "Replacement" }]);
});

it("unclaim only resets claimed/in-progress records and rejects request options", async () => {
  for (const status of ["claimed", "in_progress", "completed", "pending", "completing"]) {
    db.run("INSERT INTO tasks (id, subject, description, status, claimed_at, started_at) VALUES (?, ?, '', ?, 'old', 'old')", [status, status, status]);
  }
  const app = new Hono<{ Variables: { db: Database } }>();
  app.use("*", async (c, next) => { c.set("db", db); await next(); });
  app.onError((error, c) => formatErrorResponse(c, error));
  app.route("/maintenance", createTaskMaintenanceRoutes());
  const send = (body: unknown) => app.request("/maintenance/unclaim", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await send({ status: "completed" })).status).toBe(400);
  const result = await (await send({})).json();
  expect(result.unclaimed).toBe(2);
  expect(db.query("SELECT status, assigned_to, claimed_at, started_at FROM tasks WHERE id = 'claimed'").get())
    .toEqual({ status: "pending", assigned_to: null, claimed_at: null, started_at: null });
  expect(db.query("SELECT status FROM tasks WHERE id = 'completed'").get()).toEqual({ status: "completed" });
});
