import { actionKey } from "../db/swarm-actions";
import { proposalSchema } from "../brain/swarm/types";
import type { Database } from "bun:sqlite";
import type { SwarmProposal } from "../brain/swarm/types";
import type { WorkbenchInboxRecord } from "../types/adaptive-cards";

interface RecommendationRow {
  id: string;
  evaluation_id: string;
  proposal: string;
  created_at: string;
  disposition: string;
  detail: string;
  mode: string;
  window_since: string | null;
  window_until: string | null;
  action_id: string | null;
  action_status: string | null;
  action_detail: string | null;
}

const SELECT_RECOMMENDATIONS = `SELECT r.*, e.mode,
  json_extract(e.snapshot, '$.window.since') AS window_since,
  json_extract(e.snapshot, '$.window.until') AS window_until,
  a.id AS action_id, a.status AS action_status, a.detail AS action_detail
  FROM brain_swarm_recommendations r
  JOIN brain_swarm_evaluations e ON e.id = r.evaluation_id
  LEFT JOIN brain_swarm_actions a ON a.dedup_key = r.id`;

const STATUS_LABELS: Record<string, string> = {
  recommended: "Recommended; awaiting policy checks",
  proposed: "Proposal only",
  executing: "Execution reserved; completion not yet confirmed",
  succeeded: "Completed",
  uncertain: "Outcome uncertain; reconciliation required",
  rejected: "Not executed",
  suppressed: "Suppressed by repeat or state checks",
};
const DETAIL_LABELS: Record<string, string> = {
  capability_not_implemented: "This capability is not implemented.",
  incomplete_snapshot: "The activity snapshot is incomplete.",
  below_execution_threshold: "Confidence is below the execution threshold.",
  recent_existing_brain_action: "The Brain recently performed this action.",
  stale_target: "The target changed before execution.",
  arm_unavailable: "The arm is unavailable or blocked by planning.",
  task_lifecycle_guard: "The task's lifecycle prevents this change.",
  invalid_task_priority: "The proposed priority is not valid for tasks.",
  empty_task_patch: "No task fields would change.",
  shadow_mode: "Execution is switched off; proposals only.",
  conflicting_target: "Another action for this target was selected in this poll.",
  execution_unresolved: "An earlier action still has an unresolved outcome.",
  cooldown_or_old_evidence: "An earlier action is cooling down or this evidence predates its result.",
};

function asInboxRecord(row: RecommendationRow): WorkbenchInboxRecord {
  const proposal = proposalSchema.parse(JSON.parse(row.proposal));
  const status = row.action_status ?? row.disposition;
  const detail = row.action_detail || row.detail;
  const summary = [
    `Status: ${STATUS_LABELS[status] ?? status}`,
    detail ? `Decision: ${DETAIL_LABELS[detail] ?? detail}` : null,
    `Target: ${proposal.targetType} ${proposal.targetId}`,
    `Confidence: ${(proposal.probability * 100).toFixed(1)}% (model choice score)`,
    `Reason: ${proposal.reason.replaceAll("_", " ")}`,
    `Mode when recommended: ${row.mode === "shadow" ? "Proposals only" : "Execution enabled"}`,
    `Requested parameters: ${JSON.stringify(proposal.parameters)}`,
    row.window_since && row.window_until ? `Activity window: ${row.window_since} to ${row.window_until}` : null,
    `Evidence: ${proposal.evidenceId} at ${proposal.evidenceAt}`,
    proposal.evidenceText,
    `Evaluation: ${row.evaluation_id}`,
    row.action_id ? `Action receipt: ${row.action_id}` : null,
  ].filter((line): line is string => line !== null).join("\n\n");
  return {
    itemKey: `swarm:${row.id}`, source: "swarm-recommendation", kind: "brain",
    title: `Swarm recommendation: ${proposal.action.replaceAll("_", " ")} · ${proposal.targetId}`,
    summary, timestamp: row.created_at, resource: { kind: proposal.targetType, id: proposal.targetId },
    severity: status === "uncertain" ? "warning" : status === "succeeded" ? "success" : "info",
    requiresAction: status === "uncertain",
  };
}

/** Call inside the evaluation audit transaction, before any external effects. */
export function recordSwarmRecommendations(db: Database, evaluationId: string,
  proposals: SwarmProposal[], timestamp: string): void {
  const insert = db.query(`INSERT OR IGNORE INTO brain_swarm_recommendations
    (id,evaluation_id,proposal,created_at) VALUES (?,?,?,?)`);
  for (const proposal of proposals) insert.run(actionKey(proposal), evaluationId, JSON.stringify(proposal), timestamp);
}

export function setSwarmRecommendationDisposition(db: Database, proposal: SwarmProposal,
  disposition: string, detail: string): void {
  db.run("UPDATE brain_swarm_recommendations SET disposition=?,detail=? WHERE id=?",
    [disposition, detail, actionKey(proposal)]);
}

export function listSwarmInboxRecords(db: Database, limit: number): WorkbenchInboxRecord[] {
  return (db.query(`${SELECT_RECOMMENDATIONS} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`)
    .all(limit) as RecommendationRow[]).map(asInboxRecord);
}

export function getSwarmInboxRecord(db: Database, id: string): WorkbenchInboxRecord | null {
  const row = db.query(`${SELECT_RECOMMENDATIONS} WHERE r.id=?`).get(id) as RecommendationRow | null;
  return row ? asInboxRecord(row) : null;
}
