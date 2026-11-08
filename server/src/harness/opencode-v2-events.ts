import type { OpenCodeEvent } from "./event-stream-types";

/** Translate V2's data envelopes into Coleo's existing stream/telemetry contract. */
export function normalizeV2Event(event: { type: string; created?: number; data?: Record<string, unknown> },
  text: Map<string, string>): OpenCodeEvent {
  const data = event.data ?? {};
  const common = { sessionID: data.sessionID, messageID: data.assistantMessageID };
  if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type)) {
    const type = event.type.split(".")[1]!;
    const id = `${data.sessionID}:${data.assistantMessageID}:${type}:${data.ordinal}`;
    if (event.type.endsWith(".started")) text.set(id, "");
    const content = (text.get(id) || "") + (typeof data.delta === "string" ? data.delta : "");
    text.set(id, content.slice(-64_000));
    if (event.type.endsWith(".ended")) text.delete(id);
    return { type: "message.part.updated", properties: { ...common,
      part: { ...common, id, type, text: content.slice(-64_000) } } };
  }
  if (event.type === "session.step.ended") return { type: "message.part.updated", properties: {
    ...common, part: { ...common, type: "step-finish", tokens: data.tokens, cost: data.cost, reason: data.finish },
  } };
  if (event.type === "session.execution.failed" || event.type === "session.step.failed") {
    return { type: "session.error", properties: { ...data, error: data.error } };
  }
  return { type: event.type, properties: data };
}
