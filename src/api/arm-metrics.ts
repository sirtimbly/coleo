import type { Database } from "bun:sqlite";

interface ArmMetricValues {
  contextUsed: number;
  contextBudget: number;
  totalTokens: number;
  totalCost: number;
}

const ARM_METRIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readArmMetrics(db: Database, armId: string): ArmMetricValues | null {
  return db.query(
    `SELECT current_context_used as contextUsed, context_budget as contextBudget,
            COALESCE(total_tokens, 0) as totalTokens, COALESCE(total_cost, 0) as totalCost
     FROM arms WHERE id = ?`,
  ).get(armId) as ArmMetricValues | null;
}

export function recordMetricSnapshot(
  db: Database,
  armId: string,
  timestamp = new Date().toISOString(),
): void {
  try {
    const arm = readArmMetrics(db, armId);
    if (!arm) return;
    const previous = db.query(
      `SELECT context_used as contextUsed, context_budget as contextBudget,
              total_tokens as totalTokens, total_cost as totalCost
       FROM arm_metric_history WHERE arm_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(armId) as ArmMetricValues | null;

    if (
      previous &&
      previous.contextUsed === arm.contextUsed &&
      previous.contextBudget === arm.contextBudget &&
      previous.totalTokens === arm.totalTokens &&
      previous.totalCost === arm.totalCost
    ) return;

    db.run(
      `INSERT INTO arm_metric_history
       (arm_id, timestamp, context_used, context_budget, total_tokens, total_cost)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [armId, timestamp, arm.contextUsed, arm.contextBudget, arm.totalTokens, arm.totalCost],
    );
    db.run(
      "DELETE FROM arm_metric_history WHERE arm_id = ? AND timestamp < ?",
      [armId, new Date(Date.now() - ARM_METRIC_RETENTION_MS).toISOString()],
    );
  } catch {
    // Rolling migrations and focused tests may not have metric tables yet.
  }
}

export function recordMessageMetrics(
  db: Database,
  armId: string,
  eventType: string,
  data: Record<string, unknown>,
  timestamp = new Date().toISOString(),
): void {
  if (eventType !== "message.updated") return;
  const info = asRecord(data.info);
  if (!info || info.role !== "assistant") return;
  const messageId = typeof info.id === "string" ? info.id : null;
  const time = asRecord(info.time);
  if (!messageId || !time?.completed) return;
  const tokens = asRecord(info.tokens);
  if (!tokens) return;

  const cache = asRecord(tokens.cache);
  const inputTokens = asNumber(tokens.input);
  const outputTokens = asNumber(tokens.output);
  const reasoningTokens = asNumber(tokens.reasoning);
  const cacheReadTokens = asNumber(cache?.read ?? tokens.cacheRead);
  const cacheWriteTokens = asNumber(cache?.write ?? tokens.cacheWrite);
  const contextUsed = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
  const cost = asNumber(info.cost);
  const sessionId = typeof info.sessionID === "string"
    ? info.sessionID
    : typeof info.sessionId === "string"
      ? info.sessionId
      : null;
  const completedAt = typeof time.completed === "number"
    ? new Date(time.completed < 1_000_000_000_000 ? time.completed * 1000 : time.completed).toISOString()
    : typeof time.completed === "string" && !Number.isNaN(new Date(time.completed).getTime())
      ? new Date(time.completed).toISOString()
      : timestamp;

  try {
    db.run(
      `INSERT INTO arm_message_metrics
       (arm_id, message_id, session_id, timestamp, context_used, input_tokens,
        output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(arm_id, message_id) DO UPDATE SET
         session_id = excluded.session_id, timestamp = excluded.timestamp,
         context_used = excluded.context_used, input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens, reasoning_tokens = excluded.reasoning_tokens,
         cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
         cost = excluded.cost`,
      [armId, messageId, sessionId, completedAt, contextUsed, inputTokens, outputTokens,
        reasoningTokens, cacheReadTokens, cacheWriteTokens, cost],
    );
    const totals = db.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens), 0) as totalTokens,
              COALESCE(SUM(cost), 0) as totalCost
       FROM arm_message_metrics WHERE arm_id = ?`,
    ).get(armId) as { totalTokens: number; totalCost: number };
    db.run(
      `UPDATE arms SET current_context_used = ?, total_tokens = ?, total_cost = ?, updated_at = ? WHERE id = ?`,
      [contextUsed, totals.totalTokens, totals.totalCost, timestamp, armId],
    );
    recordMetricSnapshot(db, armId, timestamp);
  } catch {
    // Rolling migrations and focused tests may not have message metrics yet.
  }
}
