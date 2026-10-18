#!/usr/bin/env bun
// Replay saved context only. Optional --live calls JEV but never invokes action adapters.
import { Database } from "bun:sqlite";
import { projectSwarmEvents } from "../api/swarm-events";
import { swarmModelContext } from "../brain/swarm/context";
import { fitSwarmRequest } from "../brain/swarm/budget";
import { candidatesFor, routingQuestions, sharedRubrics, SwarmEvaluator } from "../brain/swarm/evaluator";
import { parseSwarmQuestions } from "../brain/swarm/prompts";
import type { EventData } from "../nats/jetstream-types";
import type { SwarmSnapshot } from "../brain/swarm/types";
import type { BrainResponsibilitySettings } from "../brain/responsibilities";

const baseline = await Bun.file("reports/jev-id-cleanup-experiment.json").json() as {
  largest: { id: string }; measurements: Array<{ id: string; at: string; sizes: { model_context: { queryChars: number } } }>;
};
const config = Bun.TOML.parse(await Bun.file(".coleo/config.toml").text()) as {
  brain?: { swarm_action_modes?: BrainResponsibilitySettings["swarmActionModes"] } };
const modes = config.brain?.swarm_action_modes ?? {};
const policy = await Bun.file(".coleo/src/brain/templates/jev-swarm-policy.jinja").text();
const text = parseSwarmQuestions(await Bun.file(".coleo/src/brain/templates/jev-swarm-questions.jinja").text());
const db = new Database(".coleo/coleo.db", { readonly: true });
let largest: SwarmSnapshot | undefined;
const measurements = baseline.measurements.map(old => {
  const row = db.query<{ snapshot: string }, [string]>("SELECT snapshot FROM brain_swarm_evaluations WHERE id=?").get(old.id)!;
  const source = JSON.parse(row.snapshot) as SwarmSnapshot;
  const raw: EventData[] = [];
  let unavailable = 0;
  for (const e of [...source.events, ...source.brainActions]) {
    try { raw.push({ type: e.type, timestamp: e.timestamp, armId: e.actor,
      sequence: Number(e.id.match(/^event-(\d+):/)?.[1]) || undefined, data: JSON.parse(e.text) }); }
    catch { unavailable++; }
  }
  const projection = projectSwarmEvents(raw);
  const snapshot: SwarmSnapshot = { ...source, events: projection.events.filter(e => e.actor !== "brain"),
    brainActions: projection.events.filter(e => e.actor === "brain"),
    coverage: { complete: source.coverage.complete && !unavailable && !projection.notes.length,
      notes: [...source.coverage.notes, ...projection.notes,
        ...(unavailable ? [`${unavailable} historical payloads were already truncated and could not be replayed`] : [])] } };
  if (old.id === baseline.largest.id) largest = snapshot;
  const candidates = candidatesFor(snapshot).filter(c => modes[c.action] !== "off");
  const build = (s: SwarmSnapshot) => ({ state: { evaluationPolicy: policy, ...swarmModelContext(s), rubrics: sharedRubrics(text),
    candidates: candidates.map(c => ({ action: c.action, targetId: c.entity.id, targetType: c.entity.kind })) },
  questions: routingQuestions(candidates, text) });
  const sharedChars = JSON.stringify(build(snapshot)).length;
  try {
    const fitted = fitSwarmRequest(snapshot, build);
    return { id: old.id, at: old.at, before: old.sizes.model_context.queryChars, sharedChars,
      ...fitted.reduction, retainedEvents: fitted.snapshot.events.length, unavailable };
  } catch (error) { return { id: old.id, error: String(error) }; }
});
db.close();
const sample = measurements.find(m => m.id === baseline.largest.id);
const output: Record<string, unknown> = { measurements, sample,
  note: "Reconstructed historical snapshots; truncated source payloads cannot be restored. Character/byte fitting uses proxies, not the provider tokenizer." };
if (Bun.argv.includes("--live")) {
  if (!process.env.JEV_API_KEY || !largest) throw new Error("JEV_API_KEY and largest snapshot required");
  try {
    const result = await new SwarmEvaluator(process.env.JEV_API_KEY, "jev-latest", undefined, modes).evaluate(largest);
    output.live = { model: result.model, elapsedMs: result.elapsedMs, decisions: result.decisions?.length,
      proposals: result.proposals.length, contextReductions: result.contextReductions, executed: 0 };
  } catch (error) { output.live = { error: error instanceof Error ? error.message : "Failed", executed: 0 }; }
}
await Bun.write("reports/jev-fitted-context-experiment.json", JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ sample, fitted: measurements.filter(m => !("error" in m)).length,
  total: measurements.length, live: output.live }, null, 2));
