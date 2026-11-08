import type { CatchupFacts } from "./inbox-catchup-facts";
import type { CatchupSource } from "../workbench/inbox-catchup";

/** Payload budgets leave room for prompts and output. Limits apply to calls, not inboxes. */
export const CATCHUP_DEFAULTS = {
  batchMessages: 64,
  inputBytes: 100_000,
  concurrency: 4,
  threadPageSize: 24,
  messageBytes: 12_000,
} as const;

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Preserve every Unicode code point, including content in the middle of long messages. */
export function splitCatchupText(text: string, bytes: number): string[] {
  if (bytes < 256) throw new Error("Catch-up metadata leaves insufficient room for message evidence.");
  const parts: string[] = [];
  let part = ""; let size = 2;
  for (const char of text) {
    const cost = jsonBytes(char) - 2;
    if (size + cost > bytes) { parts.push(part); part = ""; size = 2; }
    part += char; size += cost;
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}

export function batchCatchupRecords<T>(records: readonly T[], input: (batch: T[]) => unknown,
  bytes = CATCHUP_DEFAULTS.inputBytes as number, count = Number.MAX_SAFE_INTEGER): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  for (const record of records) {
    if (batch.length && (batch.length >= count || jsonBytes(input([...batch, record])) > bytes)) {
      batches.push(batch); batch = [];
    }
    if (jsonBytes(input([record])) > bytes) throw new Error("Catch-up record metadata exceeds the per-call budget; originals preserved.");
    batch.push(record);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Include authoritative records relevant to this batch, not the whole runtime database. */
export function catchupBatchFacts(facts: CatchupFacts | undefined, sourceIds: readonly string[]): Omit<CatchupFacts, "messages"> | null {
  if (!facts) return null;
  const messages = sourceIds.flatMap(id => facts.messages[id] ? [facts.messages[id]!] : []);
  const tasks = new Set(messages.flatMap(message => message.taskIds));
  const bugs = new Set(messages.flatMap(message => message.bugIds));
  const arms = new Set(messages.flatMap(message => message.armIds));
  const files = new Set(messages.flatMap(message => message.claimReports.map(report => report.file)));
  return { capturedAt: facts.capturedAt, policy: facts.policy, decisionRecords: facts.decisionRecords,
    tasks: facts.tasks.filter(task => tasks.has(task.id)), bugs: facts.bugs.filter(bug => bugs.has(bug.id)),
    arms: facts.arms.filter(arm => arms.has(arm.id)),
    activeClaims: facts.activeClaims.filter(claim => arms.has(claim.arm_id) || files.has(claim.file_path)) };
}

export interface CatchupOverviewRow {
  id: string; at: string; unread: boolean; subject: string; from: string;
  headers: Record<string, string>; excerpt: string; part: number; parts: number; truncated: false;
}

export function fullCatchupOverview(sources: readonly CatchupSource[]): CatchupOverviewRow[] {
  return sources.flatMap(source => {
    const parts = splitCatchupText(source.body, CATCHUP_DEFAULTS.messageBytes);
    return parts.map((excerpt, index) => ({ id: source.id, at: source.timestamp, unread: source.unread,
      subject: source.subject, from: source.from, headers: source.headers ?? {}, excerpt,
      part: index + 1, parts: parts.length, truncated: false as const }));
  });
}
