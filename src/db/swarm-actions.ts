import { createHash, randomUUID } from "node:crypto";
import { proposalSchema } from "../brain/swarm/types";
import type { Database } from "bun:sqlite";
import type { SwarmProposal, SwarmReceipt } from "../brain/swarm/types";

interface ReceiptRow {
  id: string; status: SwarmReceipt["status"]; proposal: string; created_at: string; updated_at: string; detail: string;
}
function receipt(row: ReceiptRow): SwarmReceipt {
  return { id: row.id, status: row.status, proposal: proposalSchema.parse(JSON.parse(row.proposal)),
    createdAt: row.created_at, updatedAt: row.updated_at, detail: row.detail };
}
export function actionScope(proposal: SwarmProposal): string {
  // An arm must have time to respond before either another nudge or a stop.
  const family = ["stop_arm", "prompt_arm"].includes(proposal.action) ? "arm_intervention" : proposal.action;
  return `${family}:${proposal.targetType}:${proposal.targetId}`;
}
export function actionKey(proposal: SwarmProposal): string {
  return createHash("sha256").update(JSON.stringify([
    proposal.action, ["create_bug", "log_discovery", "notify_human"].includes(proposal.action) ? "shared_evidence" : actionScope(proposal),
    proposal.evidenceId,
  ])).digest("hex");
}
export function listSwarmActions(db: Database, since: string): SwarmReceipt[] {
  return (db.query(`SELECT * FROM brain_swarm_actions
    WHERE updated_at >= ? OR status IN ('executing','uncertain') ORDER BY created_at`).all(since) as ReceiptRow[]).map(receipt);
}
export function currentEntityVersion(db: Database, kind: SwarmProposal["targetType"], id: string): string | null {
  const table = { arm: "arms", task: "tasks", bug: "bugs" }[kind];
  return (db.query(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as { updated_at: string } | null)?.updated_at ?? null;
}
export function reserveSwarmAction(db: Database, proposal: SwarmProposal, execute: boolean,
  cooldownMs: number, now = new Date().toISOString()): { reserved: boolean; receipt?: SwarmReceipt; reason?: string } {
  return db.transaction(() => {
    const key = actionKey(proposal);
    const existing = db.query("SELECT * FROM brain_swarm_actions WHERE dedup_key = ?").get(key) as ReceiptRow | null;
    if (existing && (existing.status !== "proposed" || !execute)) return { reserved: false, receipt: receipt(existing), reason: "same_evidence" };
    const previous = db.query(`SELECT * FROM brain_swarm_actions WHERE scope_key = ?
      AND status IN ('executing','uncertain','succeeded') ORDER BY updated_at DESC`).all(actionScope(proposal)) as ReceiptRow[];
    if (previous.some((row) => row.status === "executing" || row.status === "uncertain")) {
      return { reserved: false, reason: "execution_unresolved" };
    }
    const latest = previous[0];
    if (latest && (Date.parse(now) - Date.parse(latest.updated_at) < cooldownMs
      || Date.parse(proposal.evidenceAt) <= Date.parse(latest.updated_at))) {
      return { reserved: false, reason: "cooldown_or_old_evidence" };
    }
    if (execute && currentEntityVersion(db, proposal.targetType, proposal.targetId) !== proposal.expectedVersion) {
      return { reserved: false, reason: "stale_target" };
    }
    const id = existing?.id || randomUUID();
    const status: SwarmReceipt["status"] = execute ? "executing" : "proposed";
    if (existing) {
      db.run("UPDATE brain_swarm_actions SET status='executing',proposal=?,updated_at=? WHERE id=? AND status='proposed'",
        [JSON.stringify(proposal), now, id]);
    } else db.run(`INSERT INTO brain_swarm_actions
      (id,dedup_key,scope_key,status,proposal,evidence_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [id, key, actionScope(proposal), status, JSON.stringify(proposal), proposal.evidenceAt, now, now]);
    return { reserved: true, receipt: { id, status, proposal, createdAt: existing?.created_at || now, updatedAt: now, detail: "" } };
  }).immediate();
}
export function finishSwarmAction(db: Database, id: string, status: "succeeded" | "uncertain" | "rejected",
  detail: string, now = new Date().toISOString()): boolean {
  return db.run(`UPDATE brain_swarm_actions SET status=?,detail=?,updated_at=? WHERE id=? AND status='executing'`,
    [status, detail, now, id]).changes === 1;
}
