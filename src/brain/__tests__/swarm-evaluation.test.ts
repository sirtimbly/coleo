import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_070_SWARM_EVALUATIONS } from "../../db/migrations/swarm-evaluations";
import { finishSwarmAction, listSwarmActions, reserveSwarmAction } from "../../db/swarm-actions";
import { candidatesFor, routingQuestions, validateAnswers } from "../swarm/evaluator";
import { executionBlock, SwarmRunner } from "../swarm/runner";
import { windowBounds } from "../swarm/types";
import type { SwarmProposal, SwarmSnapshot } from "../swarm/types";
import type { SwarmRequest } from "../swarm/runner";

const now = "2026-09-18T12:00:00.000Z";
function proposal(overrides: Partial<SwarmProposal> = {}): SwarmProposal {
  return { action: "prompt_arm", targetId: "arm-a", targetType: "arm", expectedVersion: now,
    reason: "stalled", evidenceId: "event-1", evidenceAt: "2026-09-18T11:59:50.000Z", evidenceText: "I am waiting for follow-up.",
    probability: .99, parameters: { priority: "unchanged", status: "unchanged", prompt: "report_progress" }, ...overrides };
}
function snapshot(): SwarmSnapshot {
  return { window: windowBounds(30000, 10, Date.parse(now)), entities: [
    { id: "arm-a", kind: "arm", version: now, state: { status: "idle" } },
    { id: "task-a", kind: "task", version: now, state: { status: "pending", assigned_to: null } },
  ], events: [{ id: "event-1", timestamp: "2026-09-18T11:59:50.000Z", actor: "arm-a", target: "arm-a", type: "message", text: "Waiting" }],
  brainActions: [], discoveries: [], evaluations: [], coverage: { complete: true, notes: [] } };
}
function initialize(db: Database): void {
  db.exec(MIGRATION_070_SWARM_EVALUATIONS);
  db.exec("CREATE TABLE arms (id TEXT PRIMARY KEY, updated_at TEXT); CREATE TABLE tasks (id TEXT PRIMARY KEY, updated_at TEXT); CREATE TABLE bugs (id TEXT PRIMARY KEY, updated_at TEXT)");
  db.run("INSERT INTO arms VALUES (?,?)", ["arm-a", now]);
  db.run("INSERT INTO tasks VALUES (?,?)", ["task-a", now]);
}
let db: Database;
beforeEach(() => { db = new Database(":memory:"); initialize(db); });
afterEach(() => db.close());

describe("Swarm action ledger", () => {
  it("uses ten poll intervals, and rejects zero or invalid windows", () => {
    expect(snapshot().window.since).toBe("2026-09-18T11:55:00.000Z");
    expect(() => windowBounds(0)).toThrow();
    expect(() => windowBounds(30000, -1)).toThrow();
  });
  it("atomically reserves an action once across overlapping polls", () => {
    expect(reserveSwarmAction(db, proposal(), true, 300000, now).reserved).toBe(true);
    expect(reserveSwarmAction(db, proposal(), true, 300000, now).reserved).toBe(false);
  });
  it("suppresses paraphrased evidence and conflicting arm interventions during cooldown", () => {
    const first = reserveSwarmAction(db, proposal(), true, 300000, now);
    finishSwarmAction(db, first.receipt!.id, "succeeded", "prompt sent", now);
    const repeated = proposal({ action: "stop_arm", evidenceId: "event-2", evidenceAt: "2026-09-18T12:00:29.000Z" });
    expect(reserveSwarmAction(db, repeated, true, 300000, "2026-09-18T12:00:30.000Z").reason).toBe("cooldown_or_old_evidence");
  });
  it("requires new evidence after the prior result even when cooldown expires", () => {
    const first = reserveSwarmAction(db, proposal(), true, 300000, now);
    finishSwarmAction(db, first.receipt!.id, "succeeded", "sent", now);
    expect(reserveSwarmAction(db, proposal({ evidenceId: "old-copy" }), true, 300000, "2026-09-18T12:10:00.000Z").reserved).toBe(false);
    expect(reserveSwarmAction(db, proposal({ evidenceId: "new", evidenceAt: "2026-09-18T12:09:00.000Z" }), true, 300000, "2026-09-18T12:10:00.000Z").reserved).toBe(true);
  });
  it("does not retry an uncertain effect even after cooldown expires", () => {
    const first = reserveSwarmAction(db, proposal(), true, 300000, now);
    finishSwarmAction(db, first.receipt!.id, "uncertain", "connection lost", now);
    expect(reserveSwarmAction(db, proposal({ evidenceId: "new", evidenceAt: "2026-09-18T13:00:00.000Z" }), true, 300000, "2026-09-18T13:01:00.000Z").reason).toBe("execution_unresolved");
    expect(listSwarmActions(db, "2026-09-19T00:00:00.000Z")).toHaveLength(1);
  });
  it("rejects stale targets and can promote a shadow proposal after revalidation", () => {
    const first = reserveSwarmAction(db, proposal(), false, 300000, now);
    expect(first.receipt!.status).toBe("proposed");
    expect(reserveSwarmAction(db, proposal({ expectedVersion: "old" }), true, 300000, now).reason).toBe("stale_target");
    const promoted = reserveSwarmAction(db, proposal(), true, 300000, now);
    expect(promoted.receipt!.id).toBe(first.receipt!.id);
    expect(promoted.receipt!.status).toBe("executing");
  });
  it("does not duplicate a new bug from the same evidence under different arms", () => {
    reserveSwarmAction(db, proposal({ action: "create_bug" }), false, 300000, now);
    expect(reserveSwarmAction(db, proposal({ action: "create_bug", targetId: "arm-b", reason: "missing_record" }), false, 300000, now).reason).toBe("same_evidence");
  });
  it("keeps a crash-time reservation when the database is reopened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coleo-swarm-"));
    try {
      const path = join(dir, "test.db");
      const first = new Database(path); initialize(first);
      reserveSwarmAction(first, proposal(), true, 300000, now); first.close();
      const reopened = new Database(path);
      try { expect(reserveSwarmAction(reopened, proposal({ evidenceId: "new" }), true, 300000, now).reason).toBe("execution_unresolved"); }
      finally { reopened.close(); }
    } finally { await rm(dir, { recursive: true }); }
  });
});

describe("Swarm execution policy", () => {
  it("retains unsupported operations and uncertain or incomplete inputs as proposals", () => {
    expect(executionBlock(proposal({ action: "preserve_git_work" }), snapshot())).toBe("capability_not_implemented");
    expect(executionBlock(proposal({ action: "restart_dev_server" }), snapshot())).toBe("capability_not_implemented");
    expect(executionBlock(proposal({ probability: .5 }), snapshot())).toBe("below_execution_threshold");
    const partial = snapshot(); partial.coverage.complete = false;
    expect(executionBlock(proposal(), partial)).toBe("incomplete_snapshot");
  });
  it("respects previous legacy actions and task ownership/planning gates", () => {
    const state = snapshot();
    state.brainActions.push({ ...state.events[0]!, actor: "brain", type: "arm_prompted" });
    expect(executionBlock(proposal(), state)).toBe("recent_existing_brain_action");
    state.entities[1]!.state.blocked_category = "planning";
    expect(executionBlock(proposal({ action: "update_task", targetId: "task-a", targetType: "task",
      parameters: { priority: "unchanged", status: "pending", prompt: "investigate" } }), state)).toBe("task_lifecycle_guard");
  });
  it("rejects malformed model responses instead of manufacturing no-action decisions", () => {
    const questions = routingQuestions(candidatesFor(snapshot()));
    expect(() => validateAnswers({ answers: {} }, questions)).toThrow();
  });
});

describe("Swarm runner", () => {
  function harness(mode: "execute" | "shadow", failDispatch = false, failAudit = false) {
    const calls: string[] = [];
    const api: SwarmRequest = async <T>(path: string, _method?: string, body?: unknown): Promise<T> => {
      calls.push(path);
      let result: unknown = {};
      if (path.includes("/snapshot?")) result = snapshot();
      else if (path.endsWith("/evaluations") && failAudit) throw new Error("audit unavailable");
      else if (path.endsWith("/actions")) {
        const input = body as { proposal: SwarmProposal; execute: boolean; cooldownMs: number };
        result = reserveSwarmAction(db, input.proposal, input.execute, input.cooldownMs, now);
      } else if (path.endsWith("/finish")) {
        const input = body as { status: "succeeded" | "uncertain"; detail: string };
        result = { updated: finishSwarmAction(db, path.split("/").at(-2)!, input.status, input.detail, now) };
      } else if (path.endsWith("/prompt")) {
        if (failDispatch) throw new Error("connection lost after send");
        result = { success: true };
      }
      return result as T;
    };
    const options = { mode, api, evaluate: async () => ({ proposals: [proposal()], model: "test", elapsedMs: 1 }),
      notifyHuman: async () => {}, log: () => {} };
    return { calls, options, runner: new SwarmRunner(options) };
  }
  it("executes once across overlapping polls and a runner restart", async () => {
    const { calls, runner, options } = harness("execute");
    await Promise.all([runner.poll(30000), runner.poll(30000)]);
    await new SwarmRunner(options).poll(30000);
    expect(calls.filter((path) => path.endsWith("/prompt"))).toHaveLength(1);
    expect(listSwarmActions(db, now)[0]!.status).toBe("succeeded");
    expect(calls.indexOf("/api/brain/internal/swarm/evaluations")).toBeLessThan(calls.indexOf("/api/arms/arm-a/prompt"));
  });
  it("honors per-action restrictions even when global execution is enabled", async () => {
    for (const mode of ["shadow", "off"] as const) {
      const { calls, options } = harness("execute");
      await new SwarmRunner({ ...options, actionModes: { prompt_arm: mode } }).poll(30000);
      expect(calls.some(path => path.endsWith("/prompt"))).toBe(false);
      expect(calls.some(path => path.endsWith("/evaluations"))).toBe(true);
    }
  });
  it("records shadow proposals without effects", async () => {
    const { calls, runner } = harness("shadow"); await runner.poll(30000);
    expect(calls.some((path) => path.endsWith("/prompt"))).toBe(false);
    expect(listSwarmActions(db, now)[0]!.status).toBe("proposed");
  });
  it("does not dispatch if Brain stops while evaluation is in flight", async () => {
    const { calls, options } = harness("execute");
    const runner = new SwarmRunner({ ...options, shouldStop: () => true });
    await runner.poll(30000);
    expect(calls.some((path) => path.endsWith("/prompt") || path.endsWith("/actions"))).toBe(false);
  });
  it("awaits a live settings check and cancels an already reserved action", async () => {
    const { calls, options } = harness("execute");
    let checks = 0;
    const runner = new SwarmRunner({ ...options, shouldStop: async () => { checks++; return checks > 1; } });
    await runner.poll(30000);
    expect(calls.some((path) => path.endsWith("/prompt"))).toBe(false);
    expect(listSwarmActions(db, now)[0]!.status).toBe("rejected");
  });
  it("fails closed if the audit cannot persist, or a dispatch outcome is unknown", async () => {
    const audit = harness("execute", false, true);
    await expect(audit.runner.poll(30000)).rejects.toThrow("audit unavailable");
    expect(audit.calls.some((path) => path.endsWith("/prompt"))).toBe(false);
    const execution = harness("execute", true);
    await execution.runner.poll(30000); await execution.runner.poll(30000);
    expect(execution.calls.filter((path) => path.endsWith("/prompt"))).toHaveLength(1);
    expect(listSwarmActions(db, now)[0]!.status).toBe("uncertain");
  });
  it("fails closed on model failure: audits the error and dispatches nothing", async () => {
    const { calls, options } = harness("execute");
    const runner = new SwarmRunner({ ...options, evaluate: async () => { throw new Error("systemOne 500 model unavailable"); } });
    await expect(runner.poll(30000)).rejects.toThrow("Swarm evaluation failed; no actions dispatched");
    expect(calls.some((path) => path.endsWith("/actions"))).toBe(false);
    expect(calls.some((path) => path.endsWith("/prompt"))).toBe(false);
    // The failure itself is still audited exactly once before the throw.
    expect(calls.filter((path) => path.endsWith("/evaluations"))).toHaveLength(1);
  });
  it("treats an evaluation timeout like any other model failure", async () => {
    const { calls, options } = harness("execute");
    const runner = new SwarmRunner({ ...options, evaluate: async () => { throw new Error("systemOne request timed out after 12000ms"); } });
    await expect(runner.poll(30000)).rejects.toThrow("Swarm evaluation failed; no actions dispatched");
    expect(calls.filter((path) => path.endsWith("/evaluations"))).toHaveLength(1);
    expect(calls.some((path) => path.endsWith("/actions"))).toBe(false);
    expect(listSwarmActions(db, now)).toHaveLength(0);
  });
});
