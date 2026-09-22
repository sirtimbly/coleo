import type { EventData } from "../nats/jetstream-types";
import type { SwarmEvent } from "../brain/swarm/types";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const serialize = (value: unknown): string => JSON.stringify(value, (key, item: unknown) =>
  /api.?key|authorization|password|secret|token$/i.test(key) ? "[REDACTED]" : item);
const excerpt = (value: unknown, limit: number): string | undefined => value === undefined ? undefined
  : (typeof value === "string" ? value : serialize(value)).slice(0, limit);
const terminal = (status: unknown) => ["completed", "error", "failed", "cancelled"].includes(string(status));

interface PartRecord { event: EventData; part: Record<string, unknown>; messageKey: string }
interface Progress {
  event: EventData; lastProgressAt?: string; sessionStatus?: unknown;
  runningTools: Array<{ tool: unknown; callId: unknown; startedAt: unknown; status: unknown }>;
}

/** Project raw transport events before applying context limits. Never infer text completion from silence. */
export function projectSwarmEvents(raw: readonly EventData[], limit = 1000): {
  events: SwarmEvent[]; notes: string[];
} {
  const notes: string[] = [];
  const events: SwarmEvent[] = [];
  const parts = new Map<string, PartRecord>();
  const tools = new Map<string, PartRecord>();
  const completedMessages = new Set<string>();
  const progress = new Map<string, Progress>();
  const ordered = [...raw].sort((a, b) => a.timestamp.localeCompare(b.timestamp)
    || (a.sequence ?? 0) - (b.sequence ?? 0));
  const actor = (event: EventData) => string(event.data.actor) || event.armId || "system";
  const scope = (event: EventData) => JSON.stringify([actor(event), event.sessionId
    || event.data.sessionID || event.data.sessionId || record(event.data.part).sessionID || ""]);
  const messageKey = (event: EventData, id: unknown) => `${scope(event)}:${string(id)}`;
  const emit = (event: EventData, value: unknown, type = event.type, id?: string) => {
    let text = serialize(value);
    if (text.length > 8000) {
      notes.push(`Event ${event.sequence ?? event.type} text truncated`);
      text = text.slice(0, 8000);
    }
    events.push({ id: id ?? (event.sequence === undefined ? `${event.type}:${event.timestamp}:${actor(event)}`
      : `event-${event.sequence}:${event.timestamp}`), timestamp: event.timestamp, actor: actor(event),
    target: string(event.data.target) || event.armId || null, type, text });
  };
  for (const event of ordered) {
    const data = event.data;
    if (/heartbeat|poll_completed|swarm_evaluation/.test(event.type)) continue;
    const part = record(data.part);
    if (["message.part.delta", "message.part.updated", "session.status"].includes(event.type)) {
      const entry = progress.get(scope(event)) ?? { event, runningTools: [] };
      entry.event = event;
      if (event.type === "session.status") entry.sessionStatus = record(data.status).type;
      else entry.lastProgressAt = event.timestamp;
      progress.set(scope(event), entry);
    }
    if (event.type === "message.part.delta") continue;
    if (event.type === "message.updated") {
      const info = record(data.info);
      if (record(info.time).completed && info.id) completedMessages.add(messageKey(event, info.id));
      if (info.error) emit(event, { messageId: info.id, error: info.error }, "message.error");
      continue;
    }
    if (["session.updated", "session.status"].includes(event.type)) continue;
    if (event.type === "session.diff" && Array.isArray(data.diff) && data.diff.length === 0) continue;
    if (event.type === "message.part.updated") {
      const key = messageKey(event, part.messageID);
      if (part.type === "tool") {
        const id = string(part.callID) || string(part.id);
        if (!id) { notes.push("Tool event missing invocation identity"); continue; }
        const toolKey = `${scope(event)}:${id}`;
        const previous = tools.get(toolKey);
        // A delayed duplicate 'running' update must not resurrect a finished tool.
        if (!previous || !terminal(record(previous.part.state).status) || terminal(record(part.state).status)) {
          tools.set(toolKey, { event, part, messageKey: key });
        }
      } else if (part.type === "text") {
        if (!part.id) { notes.push("Text event missing part identity"); continue; }
        const partKey = `${key}:${part.id}`;
        const previous = parts.get(partKey);
        if (!previous || !record(previous.part.time).end || record(part.time).end) {
          parts.set(partKey, { event, part, messageKey: key });
        }
      } else if (!["reasoning", "step-start", "step-finish"].includes(string(part.type))) {
        emit(event, { part });
      }
      continue;
    }
    // Non-streamed application events (discoveries, task changes, errors, help requests)
    // retain their evidence immediately; explicit unfinished assistant text does not.
    if (event.type === "assistant.message" && (data.partial === true || data.completed === false)) continue;
    emit(event, data);
  }
  for (const [key, { event, part, messageKey: parent }] of parts) {
    if (!record(part.time).end && !completedMessages.has(parent)) continue;
    emit(event, { messageId: part.messageID, partId: part.id, text: part.text }, "assistant.message.completed", `message:${key}`);
  }
  for (const [key, { event, part }] of tools) {
    const state = record(part.state);
    if (!terminal(state.status)) {
      const entry = progress.get(scope(event))!;
      entry.runningTools.push({ tool: part.tool, callId: part.callID, startedAt: record(state.time).start ?? null,
        status: state.status });
      continue;
    }
    // Select identifying inputs, not entire file bodies, patches or search results.
    const input = record(state.input);
    const target = Object.fromEntries(["taskId", "task_id", "bugId", "bug_id", "path", "filePath", "command", "title"]
      .filter(name => input[name] !== undefined).map(name => [name, excerpt(input[name], 300)]));
    emit(event, { tool: part.tool, callId: part.callID, status: state.status, target,
      startedAt: record(state.time).start, finishedAt: record(state.time).end,
      error: excerpt(state.error, 2000), resultExcerpt: excerpt(state.output, 800),
      payloadElided: true }, "tool.completed", `tool:${key}`);
  }
  for (const [key, entry] of progress) {
    emit(entry.event, { lastProgressAt: entry.lastProgressAt, sessionStatus: entry.sessionStatus,
      runningTools: entry.runningTools }, "arm.progress", `progress:${key}`);
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  if (events.length > limit) notes.push(`Completed activity window exceeds ${limit} records`);
  return { events: events.slice(-limit), notes };
}
