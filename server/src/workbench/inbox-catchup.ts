export interface CatchupAction {
  title: string;
  context: string;
  action: string;
  sourceIds: string[];
}
export interface CatchupJevMetrics {
  requests: number; questions: number; inputTokens: number; outputTokens: number;
  models: string[]; uncertainDecisions: number;
}
export interface CatchupPlan {
  actions: CatchupAction[];
  resolvedTopics: number;
  informationalTopics: number;
  applyPolicyVersion?: 2;
  archiveSourceIds?: string[];
  retainedSources?: Array<{ sourceId: string; reason: string }>;
  factsFingerprint?: string;
  closedTopics?: Array<{ title: string; status: "resolved" | "informational"; context: string; sourceIds: string[] }>;
  analysis?: { concurrency: number; modelCalls: number; extractionBatches: number;
    comparisonBatches: number; topics: number; durationMs: number;
    engine?: "catalogue"; jev?: CatchupJevMetrics };
}
export interface CatchupJob {
  id: string;
  status: "analyzing" | "review" | "applying" | "completed" | "failed" | "recovery_required";
  startedAt: string;
  detail: string;
  unreadCount: number;
  error?: string;
  plan?: CatchupPlan;
  archivedCount?: number;
  archiveSubjects?: Array<{ sourceId: string; subject: string }>;
  sourceSubjects?: Array<{ sourceId: string; subject: string }>;
}
export interface CatchupSource {
  id: string; from: string; subject: string; body: string; timestamp: string;
  unread: boolean; mailbox: "inbox" | "sent" | "archive";
  headers?: Record<string, string>;
}
