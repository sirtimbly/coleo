import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initDatabase } from "../../db";
import { createApp } from "../server";
import { loadApiConfig } from "../config";
import { createTestEventStore, eventStore, resetEventStore, setEventStore } from "../../nats/jetstream";
import { actionKey } from "../../db/swarm-actions";
import type { WorkbenchInboxRecord } from "../../types/adaptive-cards";
import { dispatchSwarmAction } from "../../brain/swarm/runner";
import type { Database } from "bun:sqlite";
import type { SwarmProposal, SwarmSnapshot } from "../../brain/swarm/types";
import type { SwarmRequest } from "../../brain/swarm/runner";

let db: Database;
let app: ReturnType<typeof createApp>;
let version: string;
const apiKey = "swarm-test-key";
beforeEach(async () => {
  db = await initDatabase(":memory:");
  setEventStore(createTestEventStore());
  app = createApp(db, { ...loadApiConfig(), apiKey });
  version = new Date(Date.now() - 10000).toISOString();
  db.run(`INSERT INTO arms (id,name,domain,harness,status,created_at,updated_at)
    VALUES ('arm-a','Arm A','general','opencode-api','idle',?,?)`, [version, version]);
  db.run(`INSERT INTO tasks (id,subject,description,status,priority,source_type,created_at,updated_at)
    VALUES ('task-a','Fix test failure','Known failure','pending','normal','manual',?,?)`, [version, version]);
});
afterEach(() => { resetEventStore(); db.close(); });

const api: SwarmRequest = async <T>(path: string, method = "GET", body?: unknown, expectedVersion?: string): Promise<T> => {
  const response = await app.request(`http://localhost${path}`, { method,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json",
      ...(expectedVersion ? { "X-Coleo-Expected-Version": expectedVersion } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};
function makeProposal(action: SwarmProposal["action"], snapshot: SwarmSnapshot, targetId = "arm-a"): SwarmProposal {
  const entity = snapshot.entities.find((item) => item.id === targetId)!;
  return { action, targetId, targetType: entity.kind, expectedVersion: entity.version, reason: "unresolved_error",
    evidenceId: "test-event", evidenceAt: version, evidenceText: "Integration test exposes an unhandled error in task-a.",
    probability: .99, parameters: { priority: "unchanged", status: "unchanged", prompt: "investigate" } };
}
const getSnapshot = (): Promise<SwarmSnapshot> => api("/api/brain/internal/swarm/snapshot?pollIntervalMs=30000");

describe("Brain swarm API and existing execution adapters", () => {
  it("collects a shared ten-poll window, current records, and brain history in time order", async () => {
    db.run(`INSERT INTO arms (id,name,domain,harness,status,created_at,updated_at)
      VALUES ('arm-b','Arm B','general','opencode-api','idle',?,?)`, [version, version]);
    await eventStore.publishEvent("coleo.events.arm.arm-b.message", {
      type: "assistant.message", armId: "arm-b", timestamp: new Date(Date.parse(version) - 1000).toISOString(),
      data: { message: "I found a related failure in task-a" },
    });
    await eventStore.publishEvent("coleo.events.arm.arm-a.message", {
      type: "assistant.message", armId: "arm-a", timestamp: version, data: { message: "Test failed", apiKey: "must-not-leak" },
    });
    await eventStore.publishEvent("coleo.events.arm.arm-a.prompt", {
      type: "prompt_sent", armId: "arm-a", timestamp: new Date(Date.now() - 5000).toISOString(),
      data: { actor: "brain", target: "arm-a", message: "Already sent a prompt" },
    });
    await eventStore.publishEvent("coleo.events.arm.arm-a.old", {
      type: "old.message", armId: "arm-a", timestamp: new Date(Date.now() - 600000).toISOString(), data: { message: "Too old" },
    });
    const snapshot = await getSnapshot();
    expect(Date.parse(snapshot.window.until) - Date.parse(snapshot.window.since)).toBe(300000);
    expect(snapshot.events.map((event) => event.actor)).toEqual(["arm-b", "arm-a"]);
    expect(snapshot.brainActions).toHaveLength(1);
    expect(JSON.stringify(snapshot.events)).not.toContain("must-not-leak");
    expect(snapshot.entities.map((entity) => entity.id)).toContain("task-a");
    expect(snapshot.coverage.complete).toBe(true);
  });
  it("reports unavailable history as incomplete instead of interpreting silence as health", async () => {
    resetEventStore();
    const snapshot = await getSnapshot();
    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.notes.join()).toContain("unavailable");
  });
  it("keeps completed evidence ahead of more than 1000 streaming updates", async () => {
    await eventStore.publishEvent("coleo.events.arm.arm-a.message", {
      type: "assistant.message", armId: "arm-a", timestamp: version,
      data: { message: "Completed finding before stream noise" },
    });
    for (let i = 0; i < 1100; i++) await eventStore.publishEvent("coleo.events.arm.arm-a.message", {
      type: "message.part.delta", armId: "arm-a", timestamp: new Date(Date.parse(version) + i + 1).toISOString(),
      data: { sessionID: "streaming-session", delta: "unfinished" },
    });
    const snapshot = await getSnapshot();
    expect(snapshot.coverage.complete).toBe(true);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events[0]!.text).toContain("Completed finding");
    expect(JSON.stringify(snapshot.events)).not.toContain("unfinished");
    expect(snapshot.entities.find(e => e.id === "arm-a")!.state).toHaveProperty("last_output_at");
  });
  it("validates windows and reserves exactly one execution through the API", async () => {
    const invalid = await app.request("http://localhost/api/brain/internal/swarm/snapshot?pollIntervalMs=0", { headers: { "X-API-Key": apiKey } });
    expect(invalid.status).toBe(400);
    const body = { proposal: makeProposal("prompt_arm", await getSnapshot()), execute: true, cooldownMs: 300000 };
    const first = await api<{ reserved: boolean }>("/api/brain/internal/swarm/actions", "POST", body);
    const duplicate = await api<{ reserved: boolean }>("/api/brain/internal/swarm/actions", "POST", body);
    expect(first.reserved).toBe(true); expect(duplicate.reserved).toBe(false);
    expect((await getSnapshot()).evaluations[0]!.status).toBe("executing");
  });
  it("requires explicit operator reconciliation of uncertain outcomes", async () => {
    const body = { proposal: makeProposal("prompt_arm", await getSnapshot()), execute: true, cooldownMs: 300000 };
    const first = await api<{ receipt: { id: string } }>("/api/brain/internal/swarm/actions", "POST", body);
    await api(`/api/brain/internal/swarm/actions/${first.receipt.id}/finish`, "POST", { status: "uncertain", detail: "Transport failed" });
    const result = await api<{ updated: boolean }>(`/api/brain/internal/swarm/actions/${first.receipt.id}/reconcile`, "POST", {
      status: "succeeded", detail: "Operator verified prompt delivery in the arm transcript",
    });
    expect(result.updated).toBe(true);
    expect((await getSnapshot()).evaluations[0]!.status).toBe("succeeded");
  });
  it("records recommendations before execution, deduplicates overlapping polls, and updates the same Inbox entry", async () => {
    const snapshot = await getSnapshot();
    const proposal = makeProposal("comment_task", snapshot, "task-a");
    const audit = { mode: "shadow", snapshot, result: { proposals: [proposal] } };
    await api("/api/brain/internal/swarm/evaluations", "POST", audit);
    await api("/api/brain/internal/swarm/evaluations", "POST", audit);
    const key = `swarm:${actionKey(proposal)}`;
    const read = (): Promise<{ item: WorkbenchInboxRecord }> => api(`/api/workbench/inbox/records/${encodeURIComponent(key)}`);
    const first = (await read()).item;
    expect(first).toMatchObject({ itemKey: key, kind: "brain", source: "swarm-recommendation", requiresAction: false });
    expect(first.summary).toContain("awaiting policy checks");
    expect(first.summary).toContain(proposal.evidenceText);
    expect(first.summary).toContain("99.0%");
    expect(first.summary).toContain(snapshot.window.since);
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_recommendations").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_actions").get()).toEqual({ count: 0 });
    const reservation = { proposal, execute: false, cooldownMs: 300000, detail: "shadow_mode" };
    await api("/api/brain/internal/swarm/actions", "POST", reservation);
    expect((await read()).item.summary).toContain("Execution is switched off");
    await api(`/api/workbench/attention/${encodeURIComponent(key)}`, "PUT", { readAt: version });
    const execution = await api<{ receipt: { id: string } }>("/api/brain/internal/swarm/actions", "POST", { ...reservation, execute: true, detail: "" });
    await api(`/api/brain/internal/swarm/actions/${execution.receipt.id}/finish`, "POST", { status: "uncertain", detail: "Reply lost" });
    expect((await read()).item.requiresAction).toBe(true);
    await api(`/api/brain/internal/swarm/actions/${execution.receipt.id}/reconcile`, "POST", { status: "succeeded", detail: "Comment created and verified" });
    const finished = (await read()).item;
    expect(finished.itemKey).toBe(key);
    expect(finished.attention?.readAt).toBe(version);
    expect(finished.requiresAction).toBe(false);
    expect(finished.timestamp).toBe(first.timestamp);
    expect(finished.summary).toContain("Status: Completed");
    expect(finished.summary).toContain("Comment created");
    expect(finished.summary).toContain(execution.receipt.id);
    const listed = await api<{ items: WorkbenchInboxRecord[] }>("/api/workbench/inbox");
    expect(listed.items.filter((item) => item.itemKey === key)).toHaveLength(1);
  });
  it("keeps unsupported, low-confidence and suppressed recommendations in Inbox history", async () => {
    const snapshot = await getSnapshot();
    const unsupported = makeProposal("preserve_git_work", snapshot);
    const weak = { ...makeProposal("create_bug", snapshot), probability: .4 };
    const blocked = { ...makeProposal("prompt_arm", snapshot), evidenceId: "new-incident" };
    await api("/api/brain/internal/swarm/evaluations", "POST", { mode: "execute", snapshot,
      result: { proposals: [unsupported, weak, blocked] } });
    for (const [proposal, detail] of [[unsupported, "capability_not_implemented"], [weak, "below_execution_threshold"]] as const) {
      await api("/api/brain/internal/swarm/actions", "POST", { proposal, execute: false, cooldownMs: 300000, detail });
    }
    // An older unresolved execution blocks this new incident, but its recommendation is still recorded.
    await api("/api/brain/internal/swarm/actions", "POST", { proposal: makeProposal("prompt_arm", snapshot), execute: true, cooldownMs: 300000 });
    await api("/api/brain/internal/swarm/actions", "POST", { proposal: blocked, execute: true, cooldownMs: 300000 });
    const { items } = await api<{ items: WorkbenchInboxRecord[] }>("/api/workbench/inbox");
    expect(items.filter((item) => item.source === "swarm-recommendation")).toHaveLength(3);
    expect(items.find((item) => item.itemKey === `swarm:${actionKey(unsupported)}`)?.summary).toContain("not implemented");
    expect(items.find((item) => item.itemKey === `swarm:${actionKey(weak)}`)?.summary).toContain("below the execution threshold");
    expect(items.find((item) => item.itemKey === `swarm:${actionKey(blocked)}`)?.summary).toContain("unresolved outcome");
  });
  it("does not audit or publish malformed recommendations", async () => {
    const response = await app.request("http://localhost/api/brain/internal/swarm/evaluations", {
      method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "shadow", snapshot: {}, result: { proposals: [{ action: "unknown" }] } }),
    });
    expect(response.status).toBe(400);
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_evaluations").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_recommendations").get()).toEqual({ count: 0 });
  });
  it("uses the real discussion, task, discovery and bug handlers with valid payloads", async () => {
    const snapshot = await getSnapshot();
    const notify = async (): Promise<void> => {};
    await dispatchSwarmAction(makeProposal("comment_task", snapshot, "task-a"), "comment", snapshot, api, notify);
    expect(db.query("SELECT count(*) AS n FROM task_comments WHERE task_id='task-a'").get()).toEqual({ n: 1 });
    const afterComment = await getSnapshot();
    const taskUpdate = makeProposal("update_task", afterComment, "task-a");
    taskUpdate.parameters.priority = "high";
    await dispatchSwarmAction(taskUpdate, "task", afterComment, api, notify);
    expect(db.query("SELECT priority FROM tasks WHERE id='task-a'").get()).toEqual({ priority: "high" });
    await dispatchSwarmAction(makeProposal("log_discovery", snapshot), "discovery", snapshot, api, notify);
    expect(db.query("SELECT id FROM discoveries WHERE id='swarm-discovery'").get()).toEqual({ id: "swarm-discovery" });
    await dispatchSwarmAction(makeProposal("create_bug", snapshot), "bug", snapshot, api, notify);
    const fresh = await getSnapshot();
    const bug = fresh.entities.find((entity) => entity.kind === "bug")!;
    expect(bug).toBeDefined();
    const bugUpdate = makeProposal("update_bug", fresh, bug.id); bugUpdate.parameters.priority = "high";
    await dispatchSwarmAction(bugUpdate, "bug-update", fresh, api, notify);
    expect(db.query("SELECT priority FROM bugs WHERE id=?").get(bug.id)).toEqual({ priority: "high" });
  });
  it("rejects stale arm, task, and bug versions immediately before mutation", async () => {
    for (const action of ["prompt", "kill"]) {
      await expect(api(`/api/arms/arm-a/${action}`, "POST", { prompt: "test" }, "stale")).rejects.toThrow("409");
    }
    await expect(api("/api/tasks/task-a", "PATCH", { priority: "critical" }, "stale")).rejects.toThrow("409");
    expect(db.query("SELECT priority FROM tasks WHERE id='task-a'").get()).toEqual({ priority: "normal" });
    const snapshot = await getSnapshot();
    await dispatchSwarmAction(makeProposal("create_bug", snapshot), "bug", snapshot, api, async () => {});
    const bug = (await getSnapshot()).entities.find((entity) => entity.kind === "bug")!;
    await expect(api(`/api/bugs/${bug.id}`, "PATCH", { priority: "critical" }, "stale")).rejects.toThrow("409");
  });
});

describe("Evaluation API security, failure persistence, and retention", () => {
  const authHeaders = { "Content-Type": "application/json", "X-API-Key": apiKey };

  it("rejects unauthenticated and wrongly authenticated evaluation requests", async () => {
    const requests: Array<[string, string, unknown | undefined]> = [
      ["GET", "/api/brain/internal/swarm/snapshot?pollIntervalMs=30000", undefined],
      ["POST", "/api/brain/internal/swarm/evaluations", { mode: "shadow", snapshot: {}, result: {} }],
      ["POST", "/api/brain/internal/swarm/actions", { proposal: {}, execute: false, cooldownMs: 300000 }],
    ];
    for (const [method, path, body] of requests) {
      const missing = await app.request(`http://localhost${path}`, { method: method as "GET" | "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(missing.status).toBe(401);
    }
    const wrong = await app.request("http://localhost/api/brain/internal/swarm/evaluations", { method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "not-the-configured-key" },
      body: JSON.stringify({ mode: "shadow", snapshot: {}, result: {} }) });
    expect(wrong.status).toBe(401);
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_evaluations").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_actions").get()).toEqual({ count: 0 });
  });

  it("rejects malformed evaluation submissions before any audit write", async () => {
    for (const body of [
      { mode: "sideways", snapshot: {}, result: {} },
      { mode: "shadow", snapshot: {} },
      { mode: "shadow", snapshot: {}, result: { proposals: "not-an-array" } },
    ]) {
      const res = await app.request("http://localhost/api/brain/internal/swarm/evaluations", { method: "POST",
        headers: authHeaders, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_evaluations").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_recommendations").get()).toEqual({ count: 0 });
  });

  it("rejects malformed action submissions without reserving a receipt", async () => {
    const snapshot = await getSnapshot();
    const proposal = makeProposal("prompt_arm", snapshot);
    for (const body of [
      { proposal: { action: "not-a-real-action" }, execute: false, cooldownMs: 300000 },
      { proposal, execute: "yes", cooldownMs: 300000 },
      { proposal, execute: false },
    ]) {
      const res = await app.request("http://localhost/api/brain/internal/swarm/actions", { method: "POST",
        headers: authHeaders, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_actions").get()).toEqual({ count: 0 });
  });

  it("persists failed evaluations as queryable audit without recommendations", async () => {
    const snapshot = await getSnapshot();
    const res = await app.request("http://localhost/api/brain/internal/swarm/evaluations", { method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ mode: "execute", snapshot, result: { error: "model request timed out after 12000ms" } }) });
    expect(res.status).toBe(200);
    const { evaluations } = await api<{ evaluations: Array<{ mode: string; result: string }> }>("/api/brain/internal/swarm/evaluations");
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]!.mode).toBe("execute");
    expect(JSON.parse(evaluations[0]!.result).error).toContain("timed out");
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_recommendations").get()).toEqual({ count: 0 });
  });

  it("retains duplicate evaluation audits as distinct durable rows", async () => {
    const snapshot = await getSnapshot();
    const audit = { mode: "shadow", snapshot, result: { proposals: [] } };
    const first = await api<{ id: string }>("/api/brain/internal/swarm/evaluations", "POST", audit);
    const second = await api<{ id: string }>("/api/brain/internal/swarm/evaluations", "POST", audit);
    expect(second.id).not.toBe(first.id);
    expect(db.query("SELECT COUNT(*) AS count FROM brain_swarm_evaluations").get()).toEqual({ count: 2 });
  });

  it("retains evaluation audit rows until a retention policy is recorded (ADR-023 §7)", async () => {
    const snapshot = await getSnapshot();
    await api("/api/brain/internal/swarm/evaluations", "POST", { mode: "shadow", snapshot, result: { proposals: [] } });
    const ancient = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    db.run("UPDATE brain_swarm_evaluations SET created_at = ?", [ancient]);
    const { evaluations } = await api<{ evaluations: unknown[] }>("/api/brain/internal/swarm/evaluations");
    expect(evaluations).toHaveLength(1);
  });
});
