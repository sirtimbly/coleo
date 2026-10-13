import { z } from "zod";

export const ACTIONS = {
  stop_arm: "Stop an arm that is demonstrably stuck or causing damage; never stop productive work.",
  prompt_arm: "Give an arm a specific follow-up about an unresolved issue or missing progress.",
  update_task: "Correct a task's priority or pending/blocked state using current evidence.",
  comment_task: "Record a useful new finding in an existing task discussion.",
  log_discovery: "Record a new reusable finding that is not already in discoveries or prior actions.",
  create_bug: "Record a concrete malfunction that is not already tracked or resolved.",
  update_bug: "Correct an existing bug's priority or record new evidence in its description.",
  notify_human: "Send the human an actionable issue that requires human attention and has not already been sent.",
  restart_dev_server: "Propose recovery of a malfunctioning development server; requires a managed process identity.",
  preserve_git_work: "Propose preserving uncommitted work; requires verified worktree, ownership and an explicit preservation strategy.",
} as const;
export type SwarmAction = keyof typeof ACTIONS;
export type SwarmMode = "off" | "shadow" | "execute";
export const REASONS = ["stalled", "unresolved_error", "missing_record", "conflicting_state", "new_finding", "needs_human", "uncommitted_work"] as const;
export const proposalSchema = z.object({
  action: z.enum(Object.keys(ACTIONS) as [SwarmAction, ...SwarmAction[]]),
  targetId: z.string().min(1),
  targetType: z.enum(["arm", "task", "bug"]),
  expectedVersion: z.string(),
  reason: z.enum(REASONS),
  evidenceId: z.string().min(1),
  evidenceAt: z.string().datetime(),
  evidenceText: z.string().max(8000),
  probability: z.number().min(0).max(1),
  parameters: z.object({
    priority: z.enum(["critical", "high", "normal", "medium", "low", "unchanged"]).default("unchanged"),
    status: z.enum(["pending", "blocked", "unchanged"]).default("unchanged"),
    prompt: z.enum(["investigate", "report_progress", "continue_task", "verify_fix", "record_completion", "review_conflict"]).default("investigate"),
  }),
});
export type SwarmProposal = z.infer<typeof proposalSchema>;
export interface SwarmEntity {
  id: string;
  kind: "arm" | "task" | "bug";
  version: string;
  state: Record<string, unknown>;
}
export interface SwarmEvent {
  id: string;
  timestamp: string;
  actor: string;
  target: string | null;
  type: string;
  text: string;
}
export interface SwarmReceipt {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "proposed" | "executing" | "succeeded" | "uncertain" | "rejected";
  proposal: SwarmProposal;
  detail: string;
}
export interface SwarmSnapshot {
  window: { since: string; until: string; pollIntervalMs: number; windowPolls: number };
  entities: SwarmEntity[];
  events: SwarmEvent[];
  brainActions: SwarmEvent[];
  evaluations: SwarmReceipt[];
  discoveries: Array<{ id: string; title: string; details: string; taskId: string | null;
    createdAt?: string; updatedAt?: string; detailsTruncated?: boolean }>;
  coverage: { complete: boolean; notes: string[] };
}
export interface SwarmCandidate {
  action: SwarmAction;
  entity: SwarmEntity;
}
export interface SwarmEvaluation {
  contextReductions?: import("./budget").ContextReduction[];
  proposals: SwarmProposal[];
  decisions?: Array<{ action: SwarmAction; targetId: string; outcome: string; probability: number }>;
  model: string;
  elapsedMs: number;
}

export function windowBounds(pollIntervalMs: number, windowPolls = 10, now = Date.now()): SwarmSnapshot["window"] {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error("Swarm evaluation requires a positive poll interval");
  if (!Number.isSafeInteger(windowPolls) || windowPolls < 1 || windowPolls > 100) throw new Error("Window polls must be between 1 and 100");
  return { since: new Date(now - pollIntervalMs * windowPolls).toISOString(), until: new Date(now).toISOString(), pollIntervalMs, windowPolls };
}
