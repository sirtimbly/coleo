#!/usr/bin/env bun
// Offline size experiment only: no model calls, database writes, or action dispatch.
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { candidatesFor, routingQuestions, sharedRubrics } from "../brain/swarm/evaluator";
import { parseSwarmQuestions } from "../brain/swarm/prompts";
import { projectSwarmEvents } from "../api/swarm-events";
import { swarmModelContext } from "../brain/swarm/context";
import type { EventData } from "../nats/jetstream-types";
import type { SwarmEvent, SwarmSnapshot } from "../brain/swarm/types";

interface EvaluationRow { id: string; created_at: string; snapshot: string; result: string }
interface Part {
  type?: string; tool?: string; callID?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
}
const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  since: { type: "string" }, until: { type: "string" }, out: { type: "string" },
  db: { type: "string", default: ".coleo/coleo.db" },
  config: { type: "string", default: ".coleo/config.toml" },
  templates: { type: "string", default: ".coleo/src/brain/templates" },
} });
if (!values.since || !values.until || !values.out
  || !Number.isFinite(Date.parse(values.since)) || !Number.isFinite(Date.parse(values.until))) {
  throw new Error("Usage: bun run src/scripts/analyze-swarm-context.ts --since ISO --until ISO --out report.json");
}
const config = Bun.TOML.parse(await Bun.file(values.config).text()) as {
  brain?: { swarm_action_modes?: Record<string, string> };
};
const actionModes = config.brain?.swarm_action_modes ?? {};
const policy = await Bun.file(`${values.templates}/jev-swarm-policy.jinja`).text();
const questions = parseSwarmQuestions(await Bun.file(`${values.templates}/jev-swarm-questions.jinja`).text());
const db = new Database(values.db, { readonly: true });
const rows = db.query<EvaluationRow, [string, string]>(`SELECT id,created_at,snapshot,result
  FROM brain_swarm_evaluations WHERE julianday(created_at) BETWEEN julianday(?) AND julianday(?)
  ORDER BY created_at`).all(values.since, values.until);
db.close();
if (!rows.length) throw new Error("No evaluations in this interval");

function toolPart(event: SwarmEvent): Part | null {
  if (event.type !== "message.part.updated") return null;
  try {
    const data = JSON.parse(event.text) as { part?: Part };
    return data.part?.type === "tool" ? data.part : null;
  } catch {
    // Saved snapshots can be truncated mid-JSON. Extract only known envelope fields;
    // never reconstruct a supposedly complete input, output, or failure from a prefix.
    if (!/"part":\s*\{\s*"type":\s*"tool"/.test(event.text)) return null;
    const field = (name: string) => event.text.match(new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]*)"`))?.[1];
    return { type: "tool", tool: field("tool"), callID: field("callID"), state: { status: field("status") } };
  }
}

function compactTool(event: SwarmEvent): SwarmEvent {
  const part = toolPart(event);
  if (!part) return event;
  const snippet = (value: unknown, limit: number) => value === undefined ? undefined
    : (typeof value === "string" ? value : JSON.stringify(value)).slice(0, limit);
  return { ...event, text: JSON.stringify({
    tool: part.tool, callId: part.callID, status: part.state?.status,
    inputExcerpt: snippet(part.state?.input, 240),
    errorExcerpt: snippet(part.state?.error, 500),
    outputExcerpt: snippet(part.state?.output, 240),
    payloadElided: true,
    sourceTruncated: event.text.length === 2500,
  }) };
}

const variants = ["original", "drop_tools", "compact_tools", "drop_tools_and_transport", "completed_activity", "model_context"] as const;
type Variant = typeof variants[number];
function project(snapshot: SwarmSnapshot, variant: Variant): SwarmSnapshot {
  if (variant === "completed_activity") {
    const raw: EventData[] = [];
    let unavailable = 0;
    for (const event of [...snapshot.events, ...snapshot.brainActions]) {
      try {
        const data = JSON.parse(event.text) as Record<string, unknown>;
        raw.push({ type: event.type, timestamp: event.timestamp, armId: event.actor,
          sequence: Number(event.id.match(/^event-(\d+):/)?.[1]) || undefined, data });
      } catch { unavailable++; }
    }
    const projected = projectSwarmEvents(raw);
    const notes = [...snapshot.coverage.notes, ...projected.notes,
      ...(unavailable ? [`${unavailable} historical payloads were already truncated and could not be replayed`] : [])];
    return { ...snapshot, events: projected.events.filter(e => e.actor !== "brain"),
      brainActions: projected.events.filter(e => e.actor === "brain"),
      coverage: { complete: snapshot.coverage.complete && notes.length === 0, notes } };
  }
  // Intentionally retain all Brain actions, entity state, discoveries, receipts and
  // coverage flags. The final variant is a lossy lower bound, not a production filter.
  const events = snapshot.events.flatMap((event) => {
    if (variant === "original") return [event];
    if (variant === "compact_tools") return [compactTool(event)];
    if (toolPart(event)) return [];
    if (variant === "drop_tools_and_transport" && [
      "message.part.delta", "message.updated", "session.updated", "session.status", "session.diff",
    ].includes(event.type)) return [];
    return [event];
  });
  return { ...snapshot, events };
}
const bytes = (value: unknown) => JSON.stringify(value).length;
const measurements = rows.map((row) => {
  const snapshot = JSON.parse(row.snapshot) as SwarmSnapshot;
  const result = JSON.parse(row.result) as { error?: string };
  const candidates = candidatesFor(snapshot).filter(c => actionModes[c.action] !== "off");
  const routing = routingQuestions(candidates, questions);
  const wireCandidates = candidates.map(c => ({ action: c.action, targetId: c.entity.id, targetType: c.entity.kind }));
  const sizes = Object.fromEntries(variants.map(variant => {
    const projected = variant === "model_context" ? swarmModelContext(project(snapshot, "completed_activity")) : project(snapshot, variant);
    const queryChars = bytes({ state: { evaluationPolicy: policy, ...projected, rubrics: sharedRubrics(questions), candidates: wireCandidates }, questions: routing });
    return [variant, { snapshotChars: bytes(projected), queryChars, events: projected.events.length,
      withinBudget: queryChars <= 100000 }];
  })) as Record<Variant, { snapshotChars: number; queryChars: number; events: number; withinBudget: boolean }>;
  const tools = snapshot.events.filter(event => toolPart(event));
  return { id: row.id, at: row.created_at, historicalError: result.error ?? null,
    coverageComplete: snapshot.coverage.complete, toolEvents: tools.length,
    truncatedToolEvents: tools.filter(event => event.text.length === 2500).length,
    candidates: candidates.length, sizes };
});
const largest = measurements.reduce((a, b) => a.sizes.original.snapshotChars > b.sizes.original.snapshotChars ? a : b);
const largestSnapshot = JSON.parse(rows.find(row => row.id === largest.id)!.snapshot) as SwarmSnapshot;
const eventTypes: Record<string, { count: number; chars: number }> = {};
for (const event of largestSnapshot.events) {
  const key = toolPart(event) ? "tool part updates" : event.type;
  const item = eventTypes[key] ??= { count: 0, chars: 0 };
  item.count++; item.chars += bytes(event);
}
const summary = Object.fromEntries(variants.map(variant => [variant, {
  withinBudget: measurements.filter(m => m.sizes[variant].withinBudget).length,
  rescuedHistoricalErrors: measurements.filter(m => m.historicalError && m.sizes[variant].withinBudget).length,
  largestQueryChars: Math.max(...measurements.map(m => m.sizes[variant].queryChars)),
} ]));
const report = {
  since: values.since, until: values.until, evaluations: rows.length, actionModes,
  methodology: "Offline routing-request sizes using current local prompts and action switches, held constant across variants. Not a model-quality or latency test. No execution or API calls.",
  limitations: [
    "Historical prompts/switches were not persisted; reconstructed query sizes may differ from original requests.",
    "Existing 2500-character truncation and 1000-event cap already lost evidence; coverage flags remain unchanged.",
    "Drop variants remove possible failure, progress and action evidence. Transport removal can lose text when final messages are absent.",
    "Only routing-request size measured; detail questions can add more input.",
    "Completed-activity replay skips historically truncated JSON and keeps coverage incomplete; its sizes are lower bounds when payloads were unavailable.",
    "Model-context variant additionally removes activity transport IDs and limits task descriptions to 256 characters.",
    "Overlapping polls are not independent samples.",
  ],
  summary, largest: { ...largest, eventTypes,
    fields: Object.fromEntries(Object.entries(largestSnapshot).map(([key, value]) => [key, bytes(value)])),
  }, measurements,
};
await Bun.write(values.out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ evaluations: rows.length, summary, largest: largest.sizes, report: values.out }, null, 2));
