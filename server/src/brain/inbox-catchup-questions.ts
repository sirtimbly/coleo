import type { Questions } from "@typesafe-ai/sdk";

export interface JevCatchupRequest { state: Record<string, unknown>; questions: Questions }
export type JevCatchupQuery = (request: JevCatchupRequest) => Promise<unknown>;

/** Conservative UTF-8 bounds for per-question and total JEV context. No evidence is cut. */
export function batchJevCatchupQuestions(state: Record<string, unknown>, questions: Questions): Questions[] {
  const stateBytes = Buffer.byteLength(JSON.stringify(state));
  const batches: Questions[] = [];
  let batch: Questions = {};
  let total = stateBytes;
  for (const [id, question] of Object.entries(questions)) {
    const size = Buffer.byteLength(JSON.stringify({ [id]: question }));
    if (stateBytes + size > 28_000) throw new Error("JEV catch-up state exceeds its safe per-question budget; no messages were archived.");
    if (Object.keys(batch).length && (total + size > 56_000 || Object.keys(batch).length >= 48)) {
      batches.push(batch); batch = {}; total = stateBytes;
    }
    batch[id] = question; total += size;
  }
  if (Object.keys(batch).length) batches.push(batch);
  return batches;
}
